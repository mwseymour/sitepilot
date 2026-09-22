<?php
/**
 * Signed REST transport for the SitePilot Gutenberg v2 lifecycle.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Rest;

use SitePilot\Registration\Store;
use SitePilot\Security\Signed_Request_Verifier;
use SitePilot\V2\Commit_Service;
use SitePilot\V2\Editor_Session;
use SitePilot\V2\Feature;
use SitePilot\V2\Media_Service;

/** Registers /wp-json/sitepilot/v2 routes. */
final class V2_Routes {

	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
	}

	public static function register_routes(): void {
		self::signed_route( '/editor-sessions', 'editor_sessions', 201 );
		register_rest_route(
			'sitepilot/v2',
			'/editor-bootstrap',
			array(
				'methods'             => 'POST',
				'callback'            => array( self::class, 'editor_bootstrap' ),
				'permission_callback' => '__return_true',
			)
		);
		self::signed_route( '/prepare', 'prepare', 201 );
		self::signed_route( '/commit', 'commit', 200 );
		self::signed_route( '/reconcile', 'reconcile', 200 );
		self::signed_route( '/readback', 'readback', 200 );
		self::signed_route( '/recover', 'recover', 200 );
		self::signed_route( '/conditional-support', 'conditional_support', 200 );
		self::signed_route( '/media-bindings', 'media_bindings', 200 );
	}

	private static function signed_route( string $route, string $method, int $status ): void {
		register_rest_route(
			'sitepilot/v2',
			$route,
			array(
				'methods'             => 'POST',
				'callback'            => static function ( \WP_REST_Request $request ) use ( $method, $status ) {
					$result = call_user_func( array( self::class, $method ), $request );
					return $result instanceof \WP_Error ? $result : new \WP_REST_Response( $result, $status );
				},
				'permission_callback' => static function ( \WP_REST_Request $request ) use ( $route ) {
					return self::signed_access( $request, 'sitepilot/v2' . $route );
				},
			)
		);
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function editor_sessions( \WP_REST_Request $request ) {
		$params = self::json( $request );
		if ( $params instanceof \WP_Error ) {
			return $params;
		}
		if ( 'sitepilot.editor-session-request/v2' !== ( $params['schemaVersion'] ?? null ) || ! hash_equals( Signed_Request_Verifier::get_authenticated_site_id(), (string) ( $params['siteId'] ?? '' ) ) ) {
			return self::error( 'schema_invalid', 'The editor session request is invalid.', 400 );
		}
		return Editor_Session::mint( $params );
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function editor_bootstrap( \WP_REST_Request $request ) {
		$params = self::json( $request );
		if ( $params instanceof \WP_Error ) {
			return $params;
		}
		$token = isset( $params['bootstrapToken'] ) && is_string( $params['bootstrapToken'] ) ? $params['bootstrapToken'] : '';
		$result = Editor_Session::consume( $token );
		return $result instanceof \WP_Error ? $result : $result;
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function prepare( \WP_REST_Request $request ) {
		$params = self::json( $request );
		return $params instanceof \WP_Error ? $params : Commit_Service::prepare( $params );
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function commit( \WP_REST_Request $request ) {
		$params = self::json( $request );
		return $params instanceof \WP_Error ? $params : Commit_Service::commit( $params );
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function reconcile( \WP_REST_Request $request ) {
		$params = self::json( $request );
		return $params instanceof \WP_Error ? $params : Commit_Service::reconcile( $params );
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function readback( \WP_REST_Request $request ) {
		$params = self::json( $request );
		return $params instanceof \WP_Error ? $params : Commit_Service::readback( $params );
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function recover( \WP_REST_Request $request ) {
		$params = self::json( $request );
		return $params instanceof \WP_Error ? $params : Commit_Service::rollback( $params );
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function conditional_support( \WP_REST_Request $request ) {
		unset( $request );
		return Feature::enabled() ? Commit_Service::conditional_support() : Feature::disabled_error();
	}

	/** @return array<string, mixed>|\WP_Error */
	public static function media_bindings( \WP_REST_Request $request ) {
		$params = self::json( $request );
		return $params instanceof \WP_Error ? $params : Media_Service::bind( $params );
	}

	/** @return bool|\WP_Error */
	private static function signed_access( \WP_REST_Request $request, string $route ) {
		if ( ! Signed_Request_Verifier::verify_rest_request( $request, $route ) ) {
			return self::error( 'permission_denied', 'The SitePilot request signature is invalid.', 401 );
		}
		$site = Store::get_site( Signed_Request_Verifier::get_authenticated_site_id() );
		$user_id = is_array( $site ) ? (int) ( $site['user_id'] ?? 0 ) : 0;
		$user = $user_id > 0 ? get_user_by( 'id', $user_id ) : false;
		if ( ! $user instanceof \WP_User || ! user_can( $user, 'read' ) ) {
			return self::error( 'permission_denied', 'The registered SitePilot service identity is unavailable.', 403 );
		}
		wp_set_current_user( $user_id );
		return true;
	}

	/** @return array<string, mixed>|\WP_Error */
	private static function json( \WP_REST_Request $request ) {
		$params = $request->get_json_params();
		return is_array( $params ) ? $params : self::error( 'schema_invalid', 'Request body must be a JSON object.', 400 );
	}

	private static function error( string $code, string $message, int $status ): \WP_Error {
		return new \WP_Error( 'sitepilot_v2_' . $code, __( $message, 'sitepilot' ), array( 'status' => $status, 'code' => $code ) );
	}
}
