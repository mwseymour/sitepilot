<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Mcp\Post_Query;

final class PostQueryTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_denied_caps'] = array();
		$GLOBALS['sitepilot_test_posts'][40]   = new WP_Post( 40, 'Secret launch', '<p>Draft</p>', '', 'draft' );
		$GLOBALS['sitepilot_test_posts'][41]   = new WP_Post( 41, 'Hello world', '<p>Live</p>', '', 'publish' );
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_posts'][40], $GLOBALS['sitepilot_test_posts'][41] );
		$GLOBALS['sitepilot_test_denied_caps'] = array();
		parent::tearDown();
	}

	public function test_a_user_who_cannot_edit_a_draft_cannot_read_it(): void {
		// Hardening T5: read abilities only needed `read`.
		$GLOBALS['sitepilot_test_denied_caps'] = array( 'edit_post', 'edit_posts' );

		$this->assertSame( array( 'ok' => false, 'error' => 'post_not_found' ), Post_Query::get_post( array( 'post_id' => 40 ) ) );
		$this->assertTrue( Post_Query::get_post( array( 'post_id' => 41 ) )['ok'] );
	}

	public function test_an_editor_can_read_a_draft(): void {
		$result = Post_Query::get_post( array( 'post_id' => 40 ) );

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'draft', $result['post_status'] );
	}
}
