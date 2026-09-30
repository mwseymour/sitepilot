<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Security\Nonce_Ledger;

require_once __DIR__ . '/../includes/Security/Nonce_Ledger.php';

final class NonceLedgerTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_options'] = array();
	}

	public function test_a_nonce_is_accepted_once(): void {
		$this->assertTrue( Nonce_Ledger::claim( 'nonce-1234567890' ) );
		$this->assertFalse( Nonce_Ledger::claim( 'nonce-1234567890' ), 'A replayed nonce must be refused.' );
		$this->assertTrue( Nonce_Ledger::claim( 'nonce-0987654321' ) );
	}

	public function test_the_record_is_an_option_row_with_its_time(): void {
		Nonce_Ledger::claim( 'nonce-1234567890' );

		$stored = $GLOBALS['sitepilot_test_options'][ Nonce_Ledger::option_name( 'nonce-1234567890' ) ] ?? null;
		$this->assertIsString( $stored );
		$this->assertEqualsWithDelta( time(), (int) $stored, 5 );
		$this->assertStringStartsWith( Nonce_Ledger::OPTION_PREFIX, Nonce_Ledger::option_name( 'x' ) );
		$this->assertLessThanOrEqual( 191, strlen( Nonce_Ledger::option_name( str_repeat( 'n', 500 ) ) ) );
	}
}
