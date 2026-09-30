<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Approval_Proof;

final class ApprovalProofTest extends TestCase {

	/** The same fixture as tests/gutenberg-v2-approval-proof.test.ts. */
	private const FIXTURE_KEY_ID     = 'ak_fe812c12f3ab4ce6ac5db69ac352f906';
	private const FIXTURE_PUBLIC_KEY = '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=';
	private const FIXTURE_SIGNATURE  = 'k+HTkLyfC3v8vgKlO/M6ZqaYKF9NUZjdTxcVWXGi5rXxDsZYbXq/0urY+Qpm8A96TyRQEB4v19S5kcvpaMwIBw==';
	private const FIXTURE_STATEMENT  = '{"approvalId":"approval-fixture-1","approvedAt":"2026-09-30T10:00:00.000Z","approverId":"operator-1","audience":"sitepilot.v2.write","bindingHash":"87e86d419f5f44570257abb5a0e4d07c7c0a03d0f5b02a485f7f03bbe579b39d","candidateId":"candidate-1","expiresAt":"2026-09-30T10:30:00.000Z","keyId":"ak_fe812c12f3ab4ce6ac5db69ac352f906","schemaVersion":"sitepilot.approval-statement/v1","siteId":"site-1"}';

	private string $secret_key;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_options'] = array();
		$GLOBALS['sitepilot_test_site_id'] = 'site-1';
		$GLOBALS['sitepilot_test_sites']   = array(
			'site-1' => array( 'secret' => 'c2VjcmV0', 'client_id' => 'client-1' ),
			'site-2' => array( 'secret' => 'c2VjcmV0', 'client_id' => 'client-2' ),
		);
		$this->secret_key = sodium_crypto_sign_secretkey( sodium_crypto_sign_seed_keypair( str_repeat( "\x07", 32 ) ) );
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_sites'], $GLOBALS['sitepilot_test_site_id'] );
		parent::tearDown();
	}

	/** @return array<string, mixed> */
	private static function fixture_approval(): array {
		return array(
			'schemaVersion' => 'sitepilot.approval/v2',
			'approvalId'    => 'approval-fixture-1',
			'approverId'    => 'operator-1',
			'approvedAt'    => '2026-09-30T10:00:00.000Z',
			'expiresAt'     => '2026-09-30T10:30:00.000Z',
			'binding'       => array(
				'candidateId'           => 'candidate-1',
				'siteId'                => 'site-1',
				'operation'             => 'create_draft',
				'intentHash'            => str_repeat( 'a', 64 ),
				'contentHash'           => str_repeat( 'b', 64 ),
				'requestedFieldsHash'   => str_repeat( 'c', 64 ),
				'affectedFieldsHash'    => str_repeat( 'd', 64 ),
				'capabilityFingerprint' => str_repeat( 'e', 64 ),
				'mediaManifestHash'     => str_repeat( 'f', 64 ),
			),
		);
	}

	private function register_fixture_key( string $site_id = 'site-1' ): void {
		$GLOBALS['sitepilot_test_site_id'] = $site_id;
		$result = Approval_Proof::register_key(
			array(
				'schemaVersion' => Approval_Proof::KEY_REQUEST,
				'algorithm'     => 'ed25519',
				'keyId'         => self::FIXTURE_KEY_ID,
				'publicKey'     => self::FIXTURE_PUBLIC_KEY,
			)
		);
		$this->assertIsArray( $result );
		$GLOBALS['sitepilot_test_site_id'] = 'site-1';
	}

	/**
	 * A fresh approval signed with the fixture key.
	 *
	 * @param array<string, mixed> $changes Fields to set before signing.
	 * @return array<string, mixed>
	 */
	private function signed( array $changes = array() ): array {
		$approval = array_merge(
			self::fixture_approval(),
			array(
				'approvalId' => 'approval-' . bin2hex( random_bytes( 4 ) ),
				'approvedAt' => gmdate( 'Y-m-d\TH:i:s.000\Z', time() - 5 ),
				'expiresAt'  => gmdate( 'Y-m-d\TH:i:s.000\Z', time() + 600 ),
			),
			$changes
		);
		$statement = Approval_Proof::statement( $approval, self::FIXTURE_KEY_ID );
		$this->assertIsString( $statement );
		$approval['proof'] = array(
			'schemaVersion' => Approval_Proof::PROOF_SCHEMA,
			'algorithm'     => 'ed25519',
			'keyId'         => self::FIXTURE_KEY_ID,
			'signature'     => base64_encode( sodium_crypto_sign_detached( $statement, $this->secret_key ) ),
		);
		return $approval;
	}

	private static function refusal( ?\WP_Error $error ): string {
		self::assertInstanceOf( \WP_Error::class, $error );
		$data = $error->get_error_data();
		return (string) $data['code'] . ':' . (string) ( $data['details']['reason'] ?? '' );
	}

	public function test_the_statement_and_signature_match_the_desktop(): void {
		$this->assertSame( self::FIXTURE_STATEMENT, Approval_Proof::statement( self::fixture_approval(), self::FIXTURE_KEY_ID ) );
		$this->assertSame( self::FIXTURE_KEY_ID, Approval_Proof::key_id( base64_decode( self::FIXTURE_PUBLIC_KEY ) ) );
		$this->assertSame( self::FIXTURE_SIGNATURE, base64_encode( sodium_crypto_sign_detached( self::FIXTURE_STATEMENT, $this->secret_key ) ) );
		$this->assertTrue( sodium_crypto_sign_verify_detached( base64_decode( self::FIXTURE_SIGNATURE ), self::FIXTURE_STATEMENT, base64_decode( self::FIXTURE_PUBLIC_KEY ) ) );
	}

	public function test_a_client_without_a_key_needs_no_proof(): void {
		$this->assertFalse( Approval_Proof::required( 'site-1' ) );
		$this->assertNull( Approval_Proof::verify( 'site-1', self::fixture_approval(), 'execution-1' ) );
	}

	public function test_a_key_is_registered_only_under_its_own_id(): void {
		$wrong = Approval_Proof::register_key(
			array(
				'schemaVersion' => Approval_Proof::KEY_REQUEST,
				'algorithm'     => 'ed25519',
				'keyId'         => 'ak_' . str_repeat( '0', 32 ),
				'publicKey'     => self::FIXTURE_PUBLIC_KEY,
			)
		);
		$this->assertInstanceOf( \WP_Error::class, $wrong );
		$this->assertFalse( Approval_Proof::required( 'site-1' ) );

		$this->register_fixture_key();
		$this->assertTrue( Approval_Proof::required( 'site-1' ) );
		$this->assertFalse( Approval_Proof::required( 'site-2' ), "A key belongs to the client that registered it." );
		$this->assertSame( 'client-1', $GLOBALS['sitepilot_test_sites']['site-1']['client_id'], 'Registering a key keeps the rest of the record.' );
	}

	public function test_a_signed_approval_is_accepted(): void {
		$this->register_fixture_key();
		$this->assertNull( Approval_Proof::verify( 'site-1', $this->signed(), 'execution-1' ) );
	}

	public function test_a_made_up_approval_is_refused(): void {
		$this->register_fixture_key();
		$this->assertSame( 'approval_invalid:proof_missing', self::refusal( Approval_Proof::verify( 'site-1', self::fixture_approval(), 'execution-1' ) ) );

		$forged                        = $this->signed();
		$forged['proof']['signature']  = base64_encode( str_repeat( "\x01", 64 ) );
		$this->assertSame( 'approval_invalid:signature_invalid', self::refusal( Approval_Proof::verify( 'site-1', $forged, 'execution-1' ) ) );

		$other_key                  = $this->signed();
		$other_key['proof']['keyId'] = 'ak_' . str_repeat( '1', 32 );
		$this->assertSame( 'approval_invalid:unknown_key', self::refusal( Approval_Proof::verify( 'site-1', $other_key, 'execution-1' ) ) );
	}

	public function test_a_changed_binding_is_refused(): void {
		$this->register_fixture_key();
		$approval                           = $this->signed();
		$approval['binding']['contentHash'] = str_repeat( '9', 64 );
		$this->assertSame( 'approval_invalid:signature_invalid', self::refusal( Approval_Proof::verify( 'site-1', $approval, 'execution-1' ) ) );
	}

	public function test_an_approval_for_another_site_is_refused(): void {
		$this->register_fixture_key( 'site-2' );
		$this->assertSame( 'approval_invalid:wrong_site', self::refusal( Approval_Proof::verify( 'site-2', $this->signed(), 'execution-1' ) ) );
	}

	public function test_an_expired_or_overlong_approval_is_refused(): void {
		$this->register_fixture_key();
		$expired = $this->signed(
			array(
				'approvedAt' => gmdate( 'Y-m-d\TH:i:s.000\Z', time() - 900 ),
				'expiresAt'  => gmdate( 'Y-m-d\TH:i:s.000\Z', time() - 60 ),
			)
		);
		$error = Approval_Proof::verify( 'site-1', $expired, 'execution-1' );
		$this->assertInstanceOf( \WP_Error::class, $error );
		$this->assertSame( 'approval_expired', $error->get_error_data()['code'] );

		$overlong = $this->signed( array( 'expiresAt' => gmdate( 'Y-m-d\TH:i:s.000\Z', time() + 3600 ) ) );
		$this->assertSame( 'approval_invalid:invalid_times', self::refusal( Approval_Proof::verify( 'site-1', $overlong, 'execution-1' ) ) );
	}

	public function test_an_approval_works_for_one_execution_only(): void {
		$this->register_fixture_key();
		$approval = $this->signed();
		$this->assertNull( Approval_Proof::verify( 'site-1', $approval, 'execution-1' ) );
		$this->assertNull( Approval_Proof::verify( 'site-1', $approval, 'execution-1' ), 'A retry of the same execution passes.' );
		$this->assertSame( 'approval_invalid:approval_reused', self::refusal( Approval_Proof::verify( 'site-1', $approval, 'execution-2' ) ) );
	}
}
