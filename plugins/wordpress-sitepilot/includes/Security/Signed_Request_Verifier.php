<?php
/**
 * Verifies SitePilot HMAC request headers for MCP HTTP calls.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Security;

use SitePilot\Registration\Store;

/**
 * Validates `SITEPILOT_REQUEST_V1` signatures using stored site secrets.
 */
final class Signed_Request_Verifier {


	/**
	 * Site id header from the last successful MCP signature verification (request-scoped).
	 *
	 * @var string
	 */
	private static $authenticated_site_id = '';

	/**
	 * Why the last verification failed, from sitepilot.error/v1's auth reasons.
	 * Safe to show: nothing secret-derived.
	 *
	 * @var string|null
	 */
	private static $failure_reason = null;

	public static function get_authenticated_site_id(): string {
		return self::$authenticated_site_id;
	}

	public static function failure_reason(): ?string {
		return self::$failure_reason;
	}

	public static function reset_request_context(): void {
		self::$authenticated_site_id = '';
		self::$failure_reason        = null;
	}

	private static function refuse( string $reason ): bool {
		self::$failure_reason = $reason;
		return false;
	}

	public static function verify_mcp_request( \WP_REST_Request $request ): bool {
		$path = self::canonical_mcp_path();
		return self::verify_internal( $request, $path );
	}

	/**
	 * Verifies a signed SitePilot REST request against an exact, fixed route.
	 *
	 * The caller supplies the route rather than trusting a model- or
	 * client-provided URL.
	 */
	public static function verify_rest_request( \WP_REST_Request $request, string $route ): bool {
		$path = wp_parse_url( rest_url( ltrim( $route, '/' ) ), PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path ) {
			return self::refuse( 'invalid_signed_headers' );
		}

		return self::verify_internal( $request, rtrim( $path, '/' ) );
	}

	public static function canonical_mcp_path(): string {
		$url  = rest_url( 'sitepilot/mcp' );
		$path = wp_parse_url( $url, PHP_URL_PATH );
		if ( ! is_string( $path ) || $path === '' ) {
			return '/wp-json/sitepilot/mcp';
		}
		$path = rtrim( $path, '/' );
		return $path === '' ? '/' : $path;
	}

	private static function verify_internal( \WP_REST_Request $request, string $path ): bool {
		self::$authenticated_site_id = '';
		self::$failure_reason        = null;

		$site_id = (string) $request->get_header( 'x-sitepilot-site-id' );
		if ( $site_id === '' ) {
			return self::refuse( 'headers_missing' );
		}

		$row = Store::get_site( $site_id );
		if ( $row === null ) {
			return self::refuse( 'unknown_site' );
		}

		$body = $request->get_body();
		if ( ! is_string( $body ) ) {
			$body = '';
		}
		$payload_sha = hash( 'sha256', $body, false );
		$header_sha  = (string) $request->get_header( 'x-sitepilot-payload-sha256' );
		if ( '' === $header_sha ) {
			return self::refuse( 'headers_missing' );
		}
		if ( $header_sha !== $payload_sha ) {
			return self::refuse( 'payload_sha256_mismatch' );
		}

		$ts = (string) $request->get_header( 'x-sitepilot-timestamp' );
		$timestamp_problem = self::timestamp_problem( $ts );
		if ( null !== $timestamp_problem ) {
			return self::refuse( $timestamp_problem );
		}

		$nonce = (string) $request->get_header( 'x-sitepilot-nonce' );
		if ( strlen( $nonce ) < 12 ) {
			return self::refuse( 'invalid_signed_headers' );
		}

		$client_id = (string) $request->get_header( 'x-sitepilot-client-id' );
		if ( $client_id !== $row['client_id'] ) {
			return self::refuse( 'client_mismatch' );
		}

		$request_id = (string) $request->get_header( 'x-sitepilot-request-id' );
		if ( $request_id === '' ) {
			return self::refuse( 'invalid_signed_headers' );
		}

		$signing_input = self::build_signing_input(
			$request->get_method(),
			$path,
			$site_id,
			$request_id,
			$client_id,
			$ts,
			$nonce,
			$payload_sha
		);

		$secret_raw = base64_decode( $row['secret'], true );
		if ( $secret_raw === false || $secret_raw === '' ) {
			return self::refuse( 'unknown_site' );
		}

		$expected = hash_hmac( 'sha256', $signing_input, $secret_raw, false );
		$sig      = (string) $request->get_header( 'x-sitepilot-signature' );
		if ( $sig === '' ) {
			return self::refuse( 'headers_missing' );
		}

		if ( ! hash_equals( strtolower( $expected ), strtolower( $sig ) ) ) {
			return self::refuse( 'signature_invalid' );
		}

		if ( ! Nonce_Ledger::claim( $nonce ) ) {
			return self::refuse( 'nonce_replayed' );
		}

		self::$authenticated_site_id = $site_id;

		return true;
	}

	/** Null when the timestamp is valid and within ±120 s of this server's clock. */
	private static function timestamp_problem( string $iso ): ?string {
		if ( '' === $iso ) {
			return 'headers_missing';
		}
		try {
			$dt = new \DateTimeImmutable( $iso );
		} catch ( \Exception $e ) {
			unset( $e );
			return 'invalid_iso_timestamp';
		}
		return abs( time() - $dt->getTimestamp() ) <= 120 ? null : 'timestamp_outside_skew';
	}

	private static function build_signing_input(
		string $method,
		string $path,
		string $site_id,
		string $request_id,
		string $client_id,
		string $timestamp,
		string $nonce,
		string $payload_sha256_hex
	): string {
		$m = strtoupper( trim( $method ) );
		$p = trim( $path );
		$lines = array(
			'SITEPILOT_REQUEST_V1',
			"{$m} {$p}",
			"siteId:{$site_id}",
			"requestId:{$request_id}",
			"clientId:{$client_id}",
			"timestamp:{$timestamp}",
			"nonce:{$nonce}",
			"payloadSha256:{$payload_sha256_hex}",
		);
		return implode( "\n", $lines );
	}
}
