<?php
/**
 * Persists registration codes and per-site shared secrets (server-side only).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Registration;

/**
 * Options-backed store for registered SitePilot clients and their secrets.
 */
final class Store {

	public const OPTION_SITES = 'sitepilot_registered_sites';

	/**
	 * @param array{secret: string, client_id: string, fingerprint: string, user_id?: int, name?: string, registered_at?: int} $record Secret is base64-encoded raw bytes.
	 */
	public static function save_site( string $site_id, array $record ): void {
		$sites = self::all_rows();
		$sites[ $site_id ] = $record;
		update_option( self::OPTION_SITES, $sites, false );
	}

	public static function delete_site( string $site_id ): bool {
		$sites = self::all_rows();
		if ( ! isset( $sites[ $site_id ] ) ) {
			return false;
		}
		unset( $sites[ $site_id ] );
		update_option( self::OPTION_SITES, $sites, false );
		return true;
	}

	/**
	 * Registered clients for the settings page. Secrets are left out.
	 *
	 * @return array<int, array{site_id: string, name: string, client_id: string, fingerprint: string, user_id: int, registered_at: int}>
	 */
	public static function list_sites(): array {
		$rows = array();
		foreach ( self::all_rows() as $site_id => $row ) {
			if ( ! is_array( $row ) ) {
				continue;
			}
			$rows[] = array(
				'site_id'       => (string) $site_id,
				'name'          => isset( $row['name'] ) ? (string) $row['name'] : '',
				'client_id'     => isset( $row['client_id'] ) ? (string) $row['client_id'] : '',
				'fingerprint'   => isset( $row['fingerprint'] ) ? (string) $row['fingerprint'] : '',
				'user_id'       => isset( $row['user_id'] ) ? (int) $row['user_id'] : 0,
				'registered_at' => isset( $row['registered_at'] ) ? (int) $row['registered_at'] : 0,
			);
		}
		return $rows;
	}

	/** @return array<string, mixed> */
	private static function all_rows(): array {
		$sites = get_option( self::OPTION_SITES, array() );
		return is_array( $sites ) ? $sites : array();
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
