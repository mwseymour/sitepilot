<?php
/**
 * Public REST metadata for protocol compatibility (no secrets).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Rest;

use SitePilot\Errors\Error_Contract;
use SitePilot\Mcp\Mcp_Status;
use SitePilot\V2\Approval_Proof;
use SitePilot\V2\Feature;

/**
 * Registers /wp-json/sitepilot/v1/* routes.
 */
final class Protocol_Routes {

	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
	}

	public static function register_routes(): void {
		register_rest_route(
			'sitepilot/v1',
			'/health',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'health' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			'sitepilot/v1',
			'/echo-headers',
			array(
				'methods'             => array( 'GET', 'POST' ),
				'callback'            => array( self::class, 'echo_headers' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			'sitepilot/v1',
			'/protocol',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'protocol' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response
	 */
	public static function health( \WP_REST_Request $request ) {
		unset( $request );
		return new \WP_REST_Response(
			array(
				'status'         => 'ok',
				'plugin_version' => SITEPILOT_VERSION,
				'wp_version'     => get_bloginfo( 'version' ),
				'php_version'    => PHP_VERSION,
			),
			200
		);
	}

	/**
	 * Which SitePilot signing headers reached WordPress, by name only. Some
	 * hosts and firewalls strip unfamiliar headers, and a signed request then
	 * fails for no visible reason; the desktop's connectivity check calls this
	 * to say which one went missing.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response
	 */
	public static function echo_headers( \WP_REST_Request $request ) {
		$expected = array( 'x-sitepilot-site-id', 'x-sitepilot-client-id', 'x-sitepilot-request-id', 'x-sitepilot-timestamp', 'x-sitepilot-nonce', 'x-sitepilot-payload-sha256', 'x-sitepilot-signature' );
		$received = array();
		foreach ( $expected as $name ) {
			if ( '' !== (string) $request->get_header( $name ) ) {
				$received[] = $name;
			}
		}
		return new \WP_REST_Response(
			array(
				'received' => $received,
				'missing'  => array_values( array_diff( $expected, $received ) ),
			),
			200
		);
	}

	/**
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response
	 */
	public static function protocol( \WP_REST_Request $request ) {
		unset( $request );
		return new \WP_REST_Response(
			array(
				'protocol_version' => SITEPILOT_PROTOCOL_VERSION,
				'plugin_version' => SITEPILOT_VERSION,
				'mcp_namespace'  => 'sitepilot',
				'mcp_route'      => 'mcp',
				'mcp'            => Mcp_Status::for_protocol(),
				// What this plugin supports, so the desktop only uses what's here.
				'features'       => array( Error_Contract::FEATURE, 'render_check_v1', Approval_Proof::FEATURE, 'wordpress_sign_in_v1' ),
				'v2'             => array(
					'enabled'        => Feature::enabled(),
					'bridge_version' => Feature::BRIDGE_VERSION,
					'base_route'     => rest_url( 'sitepilot/v2' ),
				),
			),
			200
		);
	}
}
