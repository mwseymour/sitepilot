<?php
/**
 * MCP HTTP transport permission: logged-in users or SitePilot signed requests.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

use SitePilot\Security\Signed_Request_Verifier;

/**
 * Allows browser sessions (read capability) or HMAC-authenticated desktop clients.
 */
final class Mcp_Permission {

	/**
	 * @param \WP_REST_Request $request Request.
	 */
	public static function check_access( $request ): bool {
		if ( ! $request instanceof \WP_REST_Request ) {
			return false;
		}
		if ( is_user_logged_in() && current_user_can( 'read' ) ) {
			return true;
		}
		return Signed_Request_Verifier::verify_mcp_request( $request );
	}
}
