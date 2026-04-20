<?php
/**
 * Persists registration codes and per-site shared secrets (server-side only).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Registration;

/**
 * Options-backed store for the one-time registration code and trusted sites.
 */
final class Store {

	public const OPTION_CODE = 'sitepilot_registration_code';
	public const OPTION_SITES = 'sitepilot_registered_sites';

	public static function ensure_registration_code(): string {
		$code = get_option( self::OPTION_CODE, '' );
		if ( is_string( $code ) && strlen( $code ) > 0 ) {
			return $code;
		}
		$new = wp_generate_password( 32, false, false );
		update_option( self::OPTION_CODE, $new, false );
		return $new;
	}

	public static function validate_code( string $provided ): bool {
		$stored = self::ensure_registration_code();
		return hash_equals( $stored, $provided );
	}

	/**
	 * @param array{secret: string, client_id: string, fingerprint: string, user_id?: int} $record Secret is base64-encoded raw bytes.
	 */
	public static function save_site( string $site_id, array $record ): void {
		$sites = get_option( self::OPTION_SITES, array() );
		if ( ! is_array( $sites ) ) {
			$sites = array();
		}
		$sites[ $site_id ] = $record;
		update_option( self::OPTION_SITES, $sites, false );
	}

	/**
	 * @return array{secret: string, client_id: string, fingerprint: string, user_id?: int}|null
	 */
	public static function get_site( string $site_id ): ?array {
		$sites = get_option( self::OPTION_SITES, array() );
		if ( ! is_array( $sites ) || ! isset( $sites[ $site_id ] ) || ! is_array( $sites[ $site_id ] ) ) {
			return null;
		}
		$row = $sites[ $site_id ];
		if ( ! isset( $row['secret'], $row['client_id'] ) ) {
			return null;
		}
		return array(
			'secret'      => (string) $row['secret'],
			'client_id'   => (string) $row['client_id'],
			'fingerprint' => isset( $row['fingerprint'] ) ? (string) $row['fingerprint'] : '',
			'user_id'     => isset( $row['user_id'] ) ? (int) $row['user_id'] : 0,
		);
	}
}
