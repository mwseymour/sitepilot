<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Mcp\Mcp_Status;
use SitePilot\Mcp\Server_Registrar;

final class McpStatusTest extends TestCase {
	private string $previous_error_log = '';

	protected function setUp(): void {
		parent::setUp();
		unset( $GLOBALS['sitepilot_test_options'][ Mcp_Status::OPTION ] );
		Mcp_Status::reset_request_state();
		$this->previous_error_log = (string) ini_get( 'error_log' );
		ini_set( 'error_log', '/dev/null' );
	}

	protected function tearDown(): void {
		ini_set( 'error_log', $this->previous_error_log );
		Mcp_Status::reset_request_state();
		parent::tearDown();
	}

	public function test_missing_abilities_api_wins_over_a_recorded_success(): void {
		$status = Mcp_Status::evaluate( false, true, array( 'ok' => true, 'issue' => null, 'message' => null, 'since' => 1 ) );

		$this->assertFalse( $status['ok'] );
		$this->assertSame( Mcp_Status::ISSUE_ABILITIES_API_MISSING, $status['issue'] );
	}

	public function test_missing_adapter_is_reported(): void {
		$status = Mcp_Status::evaluate( true, false, null );

		$this->assertFalse( $status['ok'] );
		$this->assertSame( Mcp_Status::ISSUE_ADAPTER_MISSING, $status['issue'] );
	}

	public function test_status_is_unknown_until_a_rest_request_records_one(): void {
		$status = Mcp_Status::evaluate( true, true, null );

		$this->assertNull( $status['ok'] );
		$this->assertNull( $status['issue'] );
	}

	public function test_a_failure_is_stored_with_the_time_it_started(): void {
		Mcp_Status::record_failure( Mcp_Status::ISSUE_REGISTRATION_FAILED, 'duplicate_server_id' );

		$stored = get_option( Mcp_Status::OPTION );
		$this->assertFalse( $stored['ok'] );
		$this->assertSame( Mcp_Status::ISSUE_REGISTRATION_FAILED, $stored['issue'] );
		$this->assertSame( 'duplicate_server_id', $stored['message'] );
		$this->assertIsInt( $stored['since'] );
	}

	public function test_a_repeated_outcome_keeps_the_original_time(): void {
		update_option(
			Mcp_Status::OPTION,
			array( 'ok' => false, 'issue' => Mcp_Status::ISSUE_REGISTRATION_FAILED, 'message' => 'duplicate_server_id', 'since' => 100 )
		);

		Mcp_Status::record_failure( Mcp_Status::ISSUE_REGISTRATION_FAILED, 'duplicate_server_id' );

		$this->assertSame( 100, get_option( Mcp_Status::OPTION )['since'] );
	}

	public function test_a_later_success_replaces_a_stored_failure(): void {
		update_option(
			Mcp_Status::OPTION,
			array( 'ok' => false, 'issue' => Mcp_Status::ISSUE_ADAPTER_INIT_SKIPPED, 'message' => 'x', 'since' => 100 )
		);

		Mcp_Status::record_registered();

		$stored = get_option( Mcp_Status::OPTION );
		$this->assertTrue( $stored['ok'] );
		$this->assertNull( $stored['issue'] );
		$this->assertNotSame( 100, $stored['since'] );
	}

	public function test_rest_init_check_does_not_override_an_outcome_from_this_request(): void {
		Mcp_Status::record_registered();

		Mcp_Status::check_after_rest_init();

		$this->assertTrue( get_option( Mcp_Status::OPTION )['ok'] );
	}

	public function test_rest_init_check_records_why_registration_never_ran(): void {
		// The test bootstrap has no Abilities API, so Server_Registrar would never be hooked.
		Mcp_Status::check_after_rest_init();

		$this->assertSame( Mcp_Status::ISSUE_ABILITIES_API_MISSING, get_option( Mcp_Status::OPTION )['issue'] );
	}

	public function test_protocol_summary_leaves_out_the_message(): void {
		Mcp_Status::record_failure( Mcp_Status::ISSUE_REGISTRATION_FAILED, '/var/www/secret/path' );

		$summary = Mcp_Status::for_protocol();

		$this->assertSame( array( 'registered', 'issue' ), array_keys( $summary ) );
		$this->assertFalse( $summary['registered'] );
	}

	public function test_registrar_records_an_unexpected_adapter_object(): void {
		Server_Registrar::register_server( new stdClass() );

		$stored = get_option( Mcp_Status::OPTION );
		$this->assertFalse( $stored['ok'] );
		$this->assertSame( Mcp_Status::ISSUE_ADAPTER_INCOMPATIBLE, $stored['issue'] );
		$this->assertStringContainsString( 'stdClass', $stored['message'] );
	}

	public function test_every_issue_has_its_own_explanation(): void {
		$issues = array(
			Mcp_Status::ISSUE_ABILITIES_API_MISSING,
			Mcp_Status::ISSUE_ADAPTER_MISSING,
			Mcp_Status::ISSUE_ADAPTER_INCOMPATIBLE,
			Mcp_Status::ISSUE_ADAPTER_INIT_SKIPPED,
			Mcp_Status::ISSUE_REGISTRATION_FAILED,
		);

		$descriptions = array_map( array( Mcp_Status::class, 'describe' ), $issues );

		$this->assertCount( count( $issues ), array_unique( $descriptions ) );
		$this->assertNotContains( Mcp_Status::describe( 'unknown' ), $descriptions );
	}
}
