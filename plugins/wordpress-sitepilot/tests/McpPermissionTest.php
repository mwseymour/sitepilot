<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Mcp\Mcp_Permission;

require_once __DIR__ . '/../includes/Mcp/Mcp_Permission.php';

final class McpPermissionTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Mcp_Permission::reset_request_state();
		$GLOBALS['sitepilot_test_signed']        = false;
		$GLOBALS['sitepilot_test_verifications'] = 0;
		$GLOBALS['sitepilot_test_site_id']       = 'site-1';
		$GLOBALS['sitepilot_test_sites']         = array( 'site-1' => array( 'user_id' => 7 ) );
		$GLOBALS['sitepilot_test_users']         = array( new WP_User( 7, 'editor' ) );
		$GLOBALS['sitepilot_test_current_user']  = 0;
		$GLOBALS['sitepilot_test_denied_caps']   = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_sites'], $GLOBALS['sitepilot_test_site_id'] );
		Mcp_Permission::reset_request_state();
		parent::tearDown();
	}

	public function test_an_unsigned_request_is_refused_even_when_a_user_is_logged_in(): void {
		// A browser login or application password (T8).
		$GLOBALS['sitepilot_test_current_user'] = 7;

		$this->assertFalse( Mcp_Permission::check_access( new WP_REST_Request() ) );
	}

	public function test_a_signed_request_runs_as_the_mapped_user(): void {
		$GLOBALS['sitepilot_test_signed'] = true;

		$this->assertTrue( Mcp_Permission::check_access( new WP_REST_Request() ) );
		$this->assertSame( 7, get_current_user_id() );
	}

	public function test_a_registration_without_a_mapped_user_is_refused(): void {
		// No fallback to the first administrator (T3).
		$GLOBALS['sitepilot_test_signed'] = true;
		$GLOBALS['sitepilot_test_sites']  = array( 'site-1' => array( 'user_id' => 0 ) );

		$this->assertFalse( Mcp_Permission::check_access( new WP_REST_Request() ) );
		$this->assertSame( 0, get_current_user_id() );
	}

	public function test_a_mapped_user_that_was_deleted_is_refused(): void {
		$GLOBALS['sitepilot_test_signed'] = true;
		$GLOBALS['sitepilot_test_users']  = array();

		$this->assertFalse( Mcp_Permission::check_access( new WP_REST_Request() ) );
	}

	public function test_a_second_check_in_the_same_request_reuses_the_verified_user(): void {
		$GLOBALS['sitepilot_test_signed'] = true;
		Mcp_Permission::check_access( new WP_REST_Request() );

		$this->assertTrue( Mcp_Permission::check_access( new WP_REST_Request() ) );
		$this->assertSame( 1, $GLOBALS['sitepilot_test_verifications'], 'The single-use nonce must be checked once.' );
	}
}
