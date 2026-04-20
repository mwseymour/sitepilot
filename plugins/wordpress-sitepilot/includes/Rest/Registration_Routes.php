<?php
/**
 * Site registration handshake (desktop → WordPress).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Rest;

use SitePilot\Registration\Store;

/**
 * Registers POST /wp-json/sitepilot/v1/register.
 */
final class Registration_Routes {

	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
	}

	public static function register_routes(): void {
		register_rest_route(
			'sitepilot/v1',
			'/register',
			array(
				'methods'             => 'POST',
				'callback'            => array( self::class, 'register_site' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public static function register_site( \WP_REST_Request $request ) {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			return new \WP_Error(
				'sitepilot_invalid_json',
				__( 'Request body must be JSON.', 'sitepilot' ),
				array( 'status' => 400 )
			);
		}

		$code = isset( $params['registrationCode'] ) ? (string) $params['registrationCode'] : '';
		if ( $code === '' || ! Store::validate_code( $code ) ) {
			return new \WP_Error(
				'sitepilot_invalid_code',
				__( 'Invalid registration code.', 'sitepilot' ),
				array( 'status' => 403 )
			);
		}

		$site_id            = isset( $params['siteId'] ) ? (string) $params['siteId'] : '';
		$workspace_id       = isset( $params['workspaceId'] ) ? (string) $params['workspaceId'] : '';
		$trusted_origin     = isset( $params['trustedAppOrigin'] ) ? (string) $params['trustedAppOrigin'] : '';
		$client_id          = isset( $params['clientIdentifier'] ) ? (string) $params['clientIdentifier'] : '';
		$wordpress_username = isset( $params['wordpressUsername'] ) ? (string) $params['wordpressUsername'] : '';
		$protocol_requested = isset( $params['protocolVersion'] ) ? (string) $params['protocolVersion'] : '';
		$site_name          = isset( $params['siteName'] ) ? (string) $params['siteName'] : '';
		$site_base_url      = isset( $params['siteBaseUrl'] ) ? (string) $params['siteBaseUrl'] : '';
		$environment        = isset( $params['environment'] ) ? (string) $params['environment'] : '';
		$secret_b64         = isset( $params['sharedSecretBase64'] ) ? (string) $params['sharedSecretBase64'] : '';

		if ( $site_id === '' || $workspace_id === '' || $trusted_origin === '' || $client_id === '' ) {
			return new \WP_Error(
				'sitepilot_invalid_payload',
				__( 'Missing required registration fields.', 'sitepilot' ),
				array( 'status' => 400 )
			);
		}

		if ( $protocol_requested !== SITEPILOT_PROTOCOL_VERSION ) {
			return new \WP_Error(
				'sitepilot_protocol_mismatch',
				__( 'Protocol version mismatch.', 'sitepilot' ),
				array( 'status' => 409 )
			);
		}

		if ( $site_name === '' || $site_base_url === '' || $environment === '' || $secret_b64 === '' ) {
			return new \WP_Error(
				'sitepilot_invalid_payload',
				__( 'Missing site metadata or shared secret.', 'sitepilot' ),
				array( 'status' => 400 )
			);
		}

		$allowed_env = array( 'production', 'staging', 'development' );
		if ( ! in_array( $environment, $allowed_env, true ) ) {
			return new \WP_Error(
				'sitepilot_invalid_environment',
				__( 'Invalid environment value.', 'sitepilot' ),
				array( 'status' => 400 )
			);
		}

		$secret_raw = base64_decode( $secret_b64, true );
		if ( $secret_raw === false || strlen( $secret_raw ) < 16 ) {
			return new \WP_Error(
				'sitepilot_invalid_secret',
				__( 'Invalid shared secret.', 'sitepilot' ),
				array( 'status' => 400 )
			);
		}

		$user_id = 0;
		if ( $wordpress_username !== '' ) {
			$user = get_user_by( 'login', $wordpress_username );
			if ( ! $user instanceof \WP_User ) {
				return new \WP_Error(
					'sitepilot_invalid_wordpress_user',
					__( 'The requested WordPress username was not found.', 'sitepilot' ),
					array( 'status' => 400 )
				);
			}
			if ( ! user_can( $user, 'read' ) ) {
				return new \WP_Error(
					'sitepilot_invalid_wordpress_user',
					__( 'The requested WordPress user cannot access SitePilot MCP.', 'sitepilot' ),
					array( 'status' => 400 )
				);
			}
			$user_id = (int) $user->ID;
		}

		$fingerprint = hash( 'sha256', $secret_raw, false );

		Store::save_site(
			$site_id,
			array(
				'secret'      => base64_encode( $secret_raw ),
				'client_id'   => $client_id,
				'fingerprint' => $fingerprint,
				'user_id'     => $user_id,
			)
		);

		$created = gmdate( 'c' );

		$body = array(
			'siteId'           => $site_id,
			'workspaceId'      => $workspace_id,
			'trustedAppOrigin' => $trusted_origin,
			'clientIdentifier' => $client_id,
			'protocolVersion'  => SITEPILOT_PROTOCOL_VERSION,
			'pluginVersion'    => SITEPILOT_VERSION,
			'createdAt'        => $created,
			'status'           => 'verified',
			'credential'       => array(
				'algorithm'               => 'hmac_sha256',
				'sharedSecretFingerprint' => $fingerprint,
			),
		);

		return new \WP_REST_Response( $body, 201 );
	}
}
