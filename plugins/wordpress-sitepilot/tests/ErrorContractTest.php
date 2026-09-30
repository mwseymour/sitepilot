<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Errors\Error_Contract;

final class ErrorContractTest extends TestCase {
	public function test_every_error_carries_code_cause_and_retry_flag(): void {
		$error = Error_Contract::error( 'sitepilot_v2_', 'stale_source', 'The post changed.', 409, array( 'postId' => 12 ) );

		$this->assertSame( 'sitepilot_v2_stale_source', $error->get_error_code() );
		$this->assertSame(
			array( 'status' => 409, 'code' => 'stale_source', 'cause' => 'stale', 'retry_ok' => false, 'details' => array( 'postId' => 12 ) ),
			$error->get_error_data()
		);
	}

	public function test_an_auth_reason_makes_the_cause_auth(): void {
		$data = Error_Contract::error( 'sitepilot_', 'permission_denied', 'Refused.', 401, array(), 'timestamp_outside_skew' )->get_error_data();

		$this->assertSame( 'auth', $data['cause'] );
		$this->assertSame( array( 'reason' => 'timestamp_outside_skew' ), $data['auth'] );
	}

	public function test_unknown_codes_are_never_retryable_and_rollback_failures_never_are(): void {
		$this->assertSame( array( 'internal', false ), Error_Contract::classify( 'something_new' ) );
		$this->assertSame( array( 'internal', false ), Error_Contract::classify( 'rollback_failed' ) );
		$this->assertSame( array( 'host_environment', true ), Error_Contract::classify( 'editor_unavailable' ) );
	}

	public function test_only_known_codes_come_from_exception_messages(): void {
		$this->assertSame( 'stale_source', Error_Contract::code_from_exception( new RuntimeException( 'stale_source' ), 'conditional_commit_failed' ) );
		$this->assertSame( 'conditional_commit_failed', Error_Contract::code_from_exception( new TypeError( 'Argument #1 must be of type array' ), 'conditional_commit_failed' ) );
	}

	public function test_statuses_follow_the_cause(): void {
		$this->assertSame( 409, Error_Contract::status_for( 'idempotency_conflict', 503 ) );
		$this->assertSame( 403, Error_Contract::status_for( 'permission_denied', 503 ) );
		$this->assertSame( 503, Error_Contract::status_for( 'conditional_commit_failed', 503 ) );
	}
}
