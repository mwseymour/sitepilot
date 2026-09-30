<?php
/**
 * MCP HTTP transport permission: SitePilot signed requests only.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

use SitePilot\Registration\Store;
use SitePilot\Security\Signed_Request_Verifier;

/**
 * Allows HMAC-signed requests from a registered SitePilot client, run as the
 * WordPress user that client was registered with. A browser login or an
 * application password is not enough: local Claude and Codex clients go
 * through SitePilot's own MCP server instead.
 */
final class Mcp_Permission {

	/**
	 * The mapped user for this request, once its signature has been verified.
	 *
	 * @var int
	 */
	private static $trusted_user_id = 0;

	/**
	 * @param \WP_REST_Request $request Request.
	 */
	public static function check_access( $request ): bool {
		if ( ! $request instanceof \WP_REST_Request ) {
			return false;
		}

		// The adapter can check more than once per request. The signature's
		// nonce is single use, so later checks reuse the verified user.
		if ( self::$trusted_user_id > 0 ) {
			return get_current_user_id() === self::$trusted_user_id && current_user_can( 'read' );
		}

		if ( ! Signed_Request_Verifier::verify_mcp_request( $request ) ) {
			return false;
		}

		$site    = Store::get_site( Signed_Request_Verifier::get_authenticated_site_id() );
		$user_id = is_array( $site ) ? (int) ( $site['user_id'] ?? 0 ) : 0;
		// A registration without a mapped user never falls back to an administrator.
		if ( $user_id < 1 || ! get_user_by( 'id', $user_id ) instanceof \WP_User ) {
			return false;
		}

		wp_set_current_user( $user_id );
		self::$trusted_user_id = $user_id;

		return current_user_can( 'read' );
	}

	/**
	 * Clears the per-request user. For tests.
	 */
	public static function reset_request_state(): void {
		self::$trusted_user_id = 0;
	}
}
