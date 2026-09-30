<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Registration\Registration_Code;

require_once __DIR__ . '/../includes/Registration/Registration_Code.php';

final class RegistrationCodeTest extends TestCase {
	private mixed $old_wpdb = null;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_options'] = array();
		$this->old_wpdb                    = $GLOBALS['wpdb'] ?? null;
		// Compare-and-swap on the stored option, as MySQL does for the UPDATE.
		$GLOBALS['wpdb'] = new class() {
			public string $options = 'wp_options';

			public function update( string $table, array $data, array $where ): int {
				unset( $table );
				$name = $where['option_name'];
				if ( ( $GLOBALS['sitepilot_test_options'][ $name ] ?? null ) !== $where['option_value'] ) {
					return 0;
				}
				$GLOBALS['sitepilot_test_options'][ $name ] = $data['option_value'];
				return 1;
			}
		};
	}

	protected function tearDown(): void {
		$GLOBALS['wpdb'] = $this->old_wpdb;
		parent::tearDown();
	}

	public function test_a_code_works_once_and_is_replaced(): void {
		$code = Registration_Code::current();

		$this->assertTrue( Registration_Code::consume( $code ) );
		$this->assertFalse( Registration_Code::consume( $code ), 'A used code must not register a second client.' );
		$this->assertNotSame( $code, Registration_Code::current() );
		$this->assertSame( 32, strlen( Registration_Code::current() ) );
	}

	public function test_a_wrong_code_changes_nothing(): void {
		$code = Registration_Code::current();

		$this->assertFalse( Registration_Code::consume( 'not-the-code' ) );
		$this->assertFalse( Registration_Code::consume( '' ) );
		$this->assertSame( $code, Registration_Code::current() );
	}

	public function test_losing_a_race_to_a_concurrent_registration_fails(): void {
		$code = Registration_Code::current();
		// Another request swaps the code between this one's check and its update.
		$GLOBALS['wpdb']->update( 'wp_options', array( 'option_value' => 'someone-else' ), array( 'option_name' => Registration_Code::OPTION, 'option_value' => $code ) );

		$this->assertFalse( Registration_Code::consume( $code ) );
	}

	public function test_reset_replaces_the_code(): void {
		$code = Registration_Code::current();

		$this->assertNotSame( $code, Registration_Code::reset() );
		$this->assertFalse( Registration_Code::matches( $code ) );
	}
}
