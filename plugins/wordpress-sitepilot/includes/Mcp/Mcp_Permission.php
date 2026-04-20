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
	 * Stable user id for signed desktop MCP requests during this request lifecycle.
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
		if ( is_user_logged_in() && current_user_can( 'read' ) ) {
			return true;
		}

		if ( ! Signed_Request_Verifier::verify_mcp_request( $request ) ) {
			return false;
		}

		$user_id = self::resolve_trusted_user_id();
		if ( $user_id < 1 ) {
			return false;
		}

		wp_set_current_user( $user_id );
		self::$trusted_user_id = $user_id;

		return current_user_can( 'read' );
	}

	private static function resolve_trusted_user_id(): int {
		if ( self::$trusted_user_id > 0 ) {
			return self::$trusted_user_id;
		}

		$site_id = Signed_Request_Verifier::get_authenticated_site_id();
		if ( $site_id !== '' ) {
			$site = \SitePilot\Registration\Store::get_site( $site_id );
			if ( is_array( $site ) && ! empty( $site['user_id'] ) ) {
				return (int) $site['user_id'];
			}
		}

		$admins = get_users(
			array(
				'role'   => 'administrator',
				'number' => 1,
				'fields' => 'ID',
				'orderby' => 'ID',
				'order'   => 'ASC',
			)
		);
		if ( is_array( $admins ) && ! empty( $admins ) ) {
			return (int) $admins[0];
		}

		$readers = get_users(
			array(
				'capability' => 'read',
				'number'     => 1,
				'fields'     => 'ID',
				'orderby'    => 'ID',
				'order'      => 'ASC',
			)
		);
		if ( is_array( $readers ) && ! empty( $readers ) ) {
			return (int) $readers[0];
		}

		return 0;
	}
}
