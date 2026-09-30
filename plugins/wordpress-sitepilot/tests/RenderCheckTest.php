<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Render_Check;

require_once __DIR__ . '/../includes/V2/Render_Check.php';

if ( ! function_exists( 'render_block' ) ) {
	/** Throws for a block carrying {"marker":"throw"}, like a broken ACF template. */
	function render_block( array $block ): string {
		if ( 'throw' === ( $block['attrs']['marker'] ?? null ) ) {
			throw new RuntimeException( 'Undefined array key "title"' );
		}
		if ( 'silent' === ( $block['attrs']['marker'] ?? null ) ) {
			return '';
		}
		return '<div>' . ( $block['innerHTML'] ?? '' ) . '</div>';
	}
}
if ( ! function_exists( 'setup_postdata' ) ) {
	function setup_postdata( WP_Post $post ): bool {
		unset( $post );
		return true;
	}
}
if ( ! function_exists( 'wp_reset_postdata' ) ) {
	function wp_reset_postdata(): void {}
}
if ( ! function_exists( 'wp_strip_all_tags' ) ) {
	function wp_strip_all_tags( string $text, bool $remove_breaks = false ): string {
		unset( $remove_breaks );
		return trim( strip_tags( $text ) );
	}
}

final class RenderCheckTest extends TestCase {
	public function test_a_post_that_renders_is_ok(): void {
		$post = new WP_Post( 50, 'Fine', '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->' );

		$this->assertSame( array( 'outcome' => 'ok' ), Render_Check::render( $post ) );
	}

	public function test_a_block_that_throws_is_reported_with_its_name_and_position(): void {
		$post = new WP_Post( 51, 'Broken', '<!-- wp:acf/container {"marker":"throw"} --><!-- /wp:acf/container -->' );

		$result = Render_Check::render( $post );

		$this->assertSame( 'render_error', $result['outcome'] );
		$this->assertSame( array( 'name' => 'acf/container', 'index' => 0 ), $result['block'] );
		$this->assertStringContainsString( 'Undefined array key', $result['message'] );
	}

	public function test_content_that_renders_to_nothing_is_reported(): void {
		// The the_content stub returns its input, which here is only block comments: no text.
		$post = new WP_Post( 52, 'Silent', '<!-- wp:acf/container {"marker":"silent"} --><!-- /wp:acf/container -->' );

		$this->assertSame( 'empty_output', Render_Check::render( $post )['outcome'] );
	}

	public function test_the_request_needs_the_schema_and_an_editable_post(): void {
		$GLOBALS['sitepilot_test_posts'][53] = new WP_Post( 53, 'Draft', '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->' );

		$this->assertInstanceOf( WP_Error::class, Render_Check::check( array( 'postId' => 53 ) ) );
		$GLOBALS['sitepilot_test_denied_caps'] = array( 'edit_post' );
		$denied = Render_Check::check( array( 'schemaVersion' => Render_Check::REQUEST_SCHEMA, 'postId' => 53 ) );
		$GLOBALS['sitepilot_test_denied_caps'] = array();
		$this->assertSame( 'sitepilot_v2_permission_denied', $denied->get_error_code() );

		$this->assertSame(
			array( 'schemaVersion' => Render_Check::RESPONSE_SCHEMA, 'postId' => 53, 'outcome' => 'ok' ),
			Render_Check::check( array( 'schemaVersion' => Render_Check::REQUEST_SCHEMA, 'postId' => 53 ) )
		);
		unset( $GLOBALS['sitepilot_test_posts'][53] );
	}
}
