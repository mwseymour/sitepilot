<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Block_Usage;

final class V2BlockUsageTest extends TestCase {

	private mixed $old_wpdb = null;

	protected function tearDown(): void {
		$GLOBALS['wpdb']                       = $this->old_wpdb;
		$GLOBALS['sitepilot_test_denied_caps'] = array();
	}

	/** @param array<int, string> $contents Post content by ID, newest first. */
	private function posts( array $contents ): void {
		$this->old_wpdb  = $GLOBALS['wpdb'] ?? null;
		$GLOBALS['wpdb'] = new class( $contents ) {
			public string $posts = 'wp_posts';

			/** @param array<int, string> $contents */
			public function __construct( private array $contents ) {}

			public function esc_like( string $value ): string {
				return $value;
			}

			public function prepare( string $query, mixed ...$args ): array {
				return array( $query, $args );
			}

			/** @param array{0: string, 1: array<int, mixed>} $prepared */
			public function get_results( array $prepared ): array {
				[ , $args ] = $prepared;
				$rows       = array();
				foreach ( array_slice( $this->contents, (int) $args[2], (int) $args[1], true ) as $id => $content ) {
					$rows[] = (object) array( 'ID' => $id, 'post_content' => $content );
				}
				return $rows;
			}
		};
	}

	private const CONTAINER = '<!-- wp:acf/container {"data":{"colour":"grey"}} --><!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph --><!-- /wp:acf/container -->';

	public function test_counts_third_party_blocks_per_post_with_examples(): void {
		$this->posts(
			array(
				12 => self::CONTAINER . self::CONTAINER,
				11 => '<!-- wp:paragraph --><p>Only core</p><!-- /wp:paragraph -->',
				10 => self::CONTAINER,
			)
		);
		$result = Block_Usage::scan();
		$this->assertSame( 'sitepilot.block-usage/v2', $result['schemaVersion'] );
		$this->assertSame( 3, $result['scannedPosts'] );
		$this->assertFalse( $result['truncated'] );
		$this->assertCount( 1, $result['blocks'] );
		$container = $result['blocks'][0];
		$this->assertSame( 'acf/container', $container['name'] );
		$this->assertSame( 2, $container['posts'] );
		$this->assertSame( 3, $container['uses'] );
		// One example per post, from the newest posts first.
		$this->assertSame( array( 12, 10 ), array_column( $container['examples'], 'postId' ) );
		$this->assertSame( '{"data":{"colour":"grey"}}', $container['examples'][0]['attributes'] );
	}

	public function test_skips_posts_the_user_cannot_edit(): void {
		$this->posts( array( 12 => self::CONTAINER ) );
		$GLOBALS['sitepilot_test_denied_caps'] = array( 'edit_post' );
		$result = Block_Usage::scan();
		$this->assertSame( 0, $result['scannedPosts'] );
		$this->assertSame( array(), $result['blocks'] );
	}

	public function test_stops_at_the_post_limit_and_says_so(): void {
		$contents = array();
		for ( $id = Block_Usage::MAX_POSTS + 5; $id > 0; --$id ) {
			$contents[ $id ] = self::CONTAINER;
		}
		$this->posts( $contents );
		$result = Block_Usage::scan();
		$this->assertSame( Block_Usage::MAX_POSTS, $result['scannedPosts'] );
		$this->assertTrue( $result['truncated'] );
		$this->assertSame( Block_Usage::MAX_POSTS, $result['blocks'][0]['posts'] );
		$this->assertCount( 3, $result['blocks'][0]['examples'] );
	}
}
