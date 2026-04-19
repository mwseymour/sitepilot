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

	private const NONCE_TTL_SECONDS = 300;

	public static function verify_mcp_request( \WP_REST_Request $request ): bool {
		$path = self::canonical_mcp_path();
		return self::verify_internal( $request, $path );
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
		$site_id = (string) $request->get_header( 'x-sitepilot-site-id' );
		if ( $site_id === '' ) {
			return false;
		}

		$row = Store::get_site( $site_id );
		if ( $row === null ) {
			return false;
		}

		$body = $request->get_body();
		if ( ! is_string( $body ) ) {
			$body = '';
		}
		$payload_sha = hash( 'sha256', $body, false );
		$header_sha  = (string) $request->get_header( 'x-sitepilot-payload-sha256' );
		if ( $header_sha !== $payload_sha ) {
			return false;
		}

		$ts = (string) $request->get_header( 'x-sitepilot-timestamp' );
		if ( ! self::validate_timestamp( $ts ) ) {
			return false;
		}

		$nonce = (string) $request->get_header( 'x-sitepilot-nonce' );
		if ( strlen( $nonce ) < 12 ) {
			return false;
		}

		$client_id = (string) $request->get_header( 'x-sitepilot-client-id' );
		if ( $client_id !== $row['client_id'] ) {
			return false;
		}

		$request_id = (string) $request->get_header( 'x-sitepilot-request-id' );
		if ( $request_id === '' ) {
			return false;
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
			return false;
		}

		$expected = hash_hmac( 'sha256', $signing_input, $secret_raw, false );
		$sig      = (string) $request->get_header( 'x-sitepilot-signature' );
		if ( $sig === '' ) {
			return false;
		}

		if ( ! hash_equals( strtolower( $expected ), strtolower( $sig ) ) ) {
			return false;
		}

		$nonce_key = 'sitepilot_np_' . md5( $nonce );
		if ( get_transient( $nonce_key ) ) {
			return false;
		}
		set_transient( $nonce_key, 1, self::NONCE_TTL_SECONDS );

		return true;
	}

	private static function validate_timestamp( string $iso ): bool {
		try {
			$dt = new \DateTimeImmutable( $iso );
		} catch ( \Exception $e ) {
			unset( $e );
			return false;
		}
		$now = time();
		$ts  = $dt->getTimestamp();
		return abs( $now - $ts ) <= 120;
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
