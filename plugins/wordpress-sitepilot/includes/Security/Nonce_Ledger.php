<?php
/**
 * Records used request nonces so a signed request can't be replayed.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Security;

/**
 * Each nonce is an option row. add_option() inserts or fails on the unique
 * option name, so two parallel replays can't both pass, and an object cache
 * can't evict the record early the way it can a transient.
 */
final class Nonce_Ledger {

	public const OPTION_PREFIX = 'sitepilot_nonce_';
	public const CLEANUP_HOOK  = 'sitepilot_delete_expired_nonces';

	/** How long a nonce is remembered, in seconds. Covers the ±120 s timestamp window. */
	public const TTL_SECONDS = 300;

	public static function register_hooks(): void {
		add_action( self::CLEANUP_HOOK, array( self::class, 'delete_expired' ) );
		if ( ! wp_next_scheduled( self::CLEANUP_HOOK ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'hourly', self::CLEANUP_HOOK );
		}
	}

	/** False when the nonce was already used. */
	public static function claim( string $nonce ): bool {
		return add_option( self::option_name( $nonce ), (string) time(), '', false );
	}

	public static function delete_expired(): void {
		global $wpdb;
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND CAST(option_value AS UNSIGNED) < %d",
				$wpdb->esc_like( self::OPTION_PREFIX ) . '%',
				time() - self::TTL_SECONDS
			)
		);
	}

	public static function option_name( string $nonce ): string {
		return self::OPTION_PREFIX . hash( 'sha256', $nonce );
	}
}
