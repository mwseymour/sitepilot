<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Registration\Registration_Code;
use SitePilot\Rest\Registration_Routes;

require_once __DIR__ . '/../includes/Registration/Registration_Code.php';
require_once __DIR__ . '/../includes/Rest/Registration_Routes.php';

if ( ! defined( 'SITEPILOT_PROTOCOL_VERSION' ) ) {
	define( 'SITEPILOT_PROTOCOL_VERSION', '1.0.0' );
}

final class RegistrationRoutesTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_options']     = array();
		$GLOBALS['sitepilot_test_sites']       = array();
		$GLOBALS['sitepilot_test_users']       = array( new WP_User( 7, 'editor' ) );
		$GLOBALS['sitepilot_test_denied_caps'] = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_sites'] );
		parent::tearDown();
	}

	/** @param array<string, mixed> $overrides */
	private function register( array $overrides = array() ): mixed {
		return Registration_Routes::register_site(
			new WP_REST_Request(
				array_merge(
					array(
						'registrationCode'   => Registration_Code::current(),
						'siteId'             => 'site-new',
						'workspaceId'        => 'workspace-1',
						'trustedAppOrigin'   => 'app://sitepilot',
						'clientIdentifier'   => 'sitepilot-desktop-1',
						'wordpressUsername'  => 'editor',
						'protocolVersion'    => SITEPILOT_PROTOCOL_VERSION,
						'siteName'           => 'Example',
						'siteBaseUrl'        => 'https://example.test',
						'environment'        => 'development',
						'sharedSecretBase64' => base64_encode( random_bytes( 32 ) ),
					),
					$overrides
				)
			)
		);
	}

	public function test_a_wordpress_user_is_required(): void {
		$code   = Registration_Code::current();
		$result = $this->register( array( 'wordpressUsername' => '' ) );

		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( 'sitepilot_wordpress_user_required', $result->get_error_code() );
		$this->assertSame( $code, Registration_Code::current(), 'A rejected request must not use up the code.' );
	}

	public function test_an_existing_site_id_is_never_replaced(): void {
		$GLOBALS['sitepilot_test_sites']['site-new'] = array( 'secret' => 'original', 'user_id' => 7 );
		$code                                        = Registration_Code::current();

		$result = $this->register();

		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( 'sitepilot_site_exists', $result->get_error_code() );
		$this->assertSame( 'original', $GLOBALS['sitepilot_test_sites']['site-new']['secret'] );
		$this->assertSame( $code, Registration_Code::current() );
	}

	public function test_an_unknown_user_is_refused_before_the_code_is_used(): void {
		$code   = Registration_Code::current();
		$result = $this->register( array( 'wordpressUsername' => 'nobody' ) );

		$this->assertSame( 'sitepilot_invalid_wordpress_user', $result->get_error_code() );
		$this->assertSame( $code, Registration_Code::current() );
	}

	public function test_a_wrong_code_is_refused(): void {
		$result = $this->register( array( 'registrationCode' => 'wrong' ) );

		$this->assertSame( 'sitepilot_invalid_code', $result->get_error_code() );
		$this->assertArrayNotHasKey( 'site-new', $GLOBALS['sitepilot_test_sites'] );
	}
}
