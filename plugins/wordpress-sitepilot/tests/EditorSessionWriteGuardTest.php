<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Editor_Session;

if ( ! function_exists( 'esc_html__' ) ) {
	function esc_html__( string $text, string $domain = '' ): string {
		unset( $domain );
		return $text;
	}
}

if ( ! function_exists( 'wp_die' ) ) {
	function wp_die( string $message = '', string $title = '', array $args = array() ): void {
		unset( $title );
		throw new RuntimeException( $message . ' (' . (string) ( $args['response'] ?? '' ) . ')' );
	}
}

final class EditorSessionWriteGuardTest extends TestCase {

	private function inSession( ?array $record ): void {
		$class = new ReflectionClass( Editor_Session::class );
		$class->getProperty( 'current_session_checked' )->setValue( null, true );
		$class->getProperty( 'current_session' )->setValue( null, $record );
	}

	protected function tearDown(): void {
		$this->inSession( null );
		parent::tearDown();
	}

	public function test_outside_a_session_writes_pass(): void {
		$this->inSession( null );
		$data = array( 'post_type' => 'post', 'post_title' => 'x' );
		$this->assertSame( $data, Editor_Session::block_post_write( $data, array(), array(), true ) );
	}

	public function test_a_preview_session_lets_the_editor_create_its_first_use_records(): void {
		$this->inSession( array( 'postId' => 10, 'postType' => 'post' ) );
		foreach ( array( 'wp_global_styles', 'wp_navigation' ) as $type ) {
			$data = array( 'post_type' => $type );
			$this->assertSame( $data, Editor_Session::block_post_write( $data, array(), array(), false ) );
		}
	}

	public function test_a_preview_session_still_refuses_content_writes_and_updates(): void {
		$this->inSession( array( 'postId' => 10, 'postType' => 'post' ) );
		foreach (
			array(
				array( array( 'post_type' => 'post' ), false ),
				array( array( 'post_type' => 'page' ), false ),
				array( array( 'post_type' => 'wp_global_styles' ), true ),
				array( array( 'post_type' => 'wp_template' ), false ),
			) as [ $data, $update ]
		) {
			try {
				Editor_Session::block_post_write( $data, array(), array(), $update );
				$this->fail( 'A ' . $data['post_type'] . ( $update ? ' update' : ' insert' ) . ' got through.' );
			} catch ( RuntimeException $error ) {
				$this->assertStringContainsString( 'cannot write posts', $error->getMessage() );
			}
		}
	}
}
