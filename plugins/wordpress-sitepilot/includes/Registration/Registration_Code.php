<?php
/**
 * The single-use code a SitePilot client needs to register with this site.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Registration;

/**
 * Each successful registration uses up the code and replaces it, so a code
 * someone once saw can't be used to register another client later.
 */
final class Registration_Code {

	public const OPTION = 'sitepilot_registration_code';

	public static function current(): string {
		$code = get_option( self::OPTION, '' );
		if ( is_string( $code ) && strlen( $code ) > 0 ) {
			return $code;
		}
		return self::reset();
	}

	public static function matches( string $provided ): bool {
		return '' !== $provided && hash_equals( self::current(), $provided );
	}

	/**
	 * Uses up the code and replaces it with a new one. The replacement is a
	 * compare-and-swap on the stored value, so only the first of several
	 * concurrent registrations with the same code succeeds.
	 */
	public static function consume( string $provided ): bool {
		if ( ! self::matches( $provided ) ) {
			return false;
		}
		global $wpdb;
		$updated = $wpdb->update(
			$wpdb->options,
			array( 'option_value' => self::generate() ),
			array(
				'option_name'  => self::OPTION,
				'option_value' => $provided,
			)
		);
		wp_cache_delete( self::OPTION, 'options' );
		return 1 === $updated;
	}

	/** Replaces the code, for the settings page's Reset button. */
	public static function reset(): string {
		$new = self::generate();
		update_option( self::OPTION, $new, false );
		return $new;
	}

	private static function generate(): string {
		return wp_generate_password( 32, false, false );
	}
}
