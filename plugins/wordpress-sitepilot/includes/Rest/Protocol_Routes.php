<?php
/**
 * Public REST metadata for protocol compatibility (no secrets).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Rest;

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
			),
			200
		);
	}
}
