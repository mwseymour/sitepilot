<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Auth\WordPress_Sign_In;

final class Sign_In_Test_User extends WP_User {
	public string $user_email   = 'ann@example.com';
	public string $display_name = 'Ann Editor';
	/** @var array<int, string> */
	public array $roles = array( 'editor' );
}

final class WordPressSignInTest extends TestCase {

	private const SECRET = 'a shared secret of at least sixteen bytes';

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_denied_caps'] = array( 'manage_options' );
		$GLOBALS['sitepilot_test_sites']       = array(
			'site-1' => array(
				'secret'           => base64_encode( self::SECRET ),
				'client_id'        => 'client-1',
				'sign_in_callback' => 'https://sitepilot.example/auth/wordpress/callback',
			),
		);
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_sites'] );
		$GLOBALS['sitepilot_test_denied_caps'] = array();
		parent::tearDown();
	}

	public function test_only_https_or_local_http_callbacks_are_allowed(): void {
		$this->assertTrue( WordPress_Sign_In::is_allowed_callback( 'https://sitepilot.example/auth/wordpress/callback' ) );
		$this->assertTrue( WordPress_Sign_In::is_allowed_callback( 'http://localhost:8080/auth/wordpress/callback' ) );
		$this->assertTrue( WordPress_Sign_In::is_allowed_callback( 'http://127.0.0.1:8080/cb' ) );
		$this->assertFalse( WordPress_Sign_In::is_allowed_callback( 'http://sitepilot.example/cb' ), 'Plain http leaks the assertion.' );
		$this->assertFalse( WordPress_Sign_In::is_allowed_callback( 'https://user@sitepilot.example/cb' ) );
		$this->assertFalse( WordPress_Sign_In::is_allowed_callback( 'https://sitepilot.example/cb#fragment' ) );
		$this->assertFalse( WordPress_Sign_In::is_allowed_callback( 'javascript:alert(1)' ) );
		$this->assertFalse( WordPress_Sign_In::is_allowed_callback( '' ) );
	}

	public function test_the_assertion_names_the_user_and_is_signed_with_the_client_secret(): void {
		$user      = new Sign_In_Test_User( 42, 'ann' );
		$now       = 1_790_000_000;
		$assertion = WordPress_Sign_In::assertion( 'site-1', 'state-abcdefghijklmnop', $user, $now );

		$expected = rtrim( strtr( base64_encode( hash_hmac( 'sha256', WordPress_Sign_In::SCHEMA . "\n" . $assertion['payload'], self::SECRET, true ) ), '+/', '-_' ), '=' );
		$this->assertSame( $expected, $assertion['signature'] );

		$payload = json_decode( base64_decode( strtr( $assertion['payload'], '-_', '+/' ) ), true );
		$this->assertSame( WordPress_Sign_In::SCHEMA, $payload['schema'] );
		$this->assertSame( 'site-1', $payload['siteId'] );
		$this->assertSame( 'state-abcdefghijklmnop', $payload['state'] );
		$this->assertSame( $now + WordPress_Sign_In::TTL, $payload['expiresAt'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{32}$/', $payload['nonce'] );
		$this->assertSame(
			array( 'id' => 42, 'login' => 'ann', 'email' => 'ann@example.com', 'displayName' => 'Ann Editor', 'roles' => array( 'editor' ) ),
			$payload['user']
		);
		$this->assertTrue( $payload['capabilities']['publish_posts'] );
		$this->assertFalse( $payload['capabilities']['manage_options'] );
	}

	public function test_each_assertion_has_its_own_nonce(): void {
		$user  = new Sign_In_Test_User( 42, 'ann' );
		$first = json_decode( base64_decode( strtr( WordPress_Sign_In::assertion( 'site-1', 'state-abcdefghijklmnop', $user, 1 )['payload'], '-_', '+/' ) ), true );
		$again = json_decode( base64_decode( strtr( WordPress_Sign_In::assertion( 'site-1', 'state-abcdefghijklmnop', $user, 1 )['payload'], '-_', '+/' ) ), true );
		$this->assertNotSame( $first['nonce'], $again['nonce'] );
	}
}
