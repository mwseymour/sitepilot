<?php
/**
 * Server-observable editor runtime fingerprint.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * Captures the server-side inputs that can make a compiled candidate stale.
 */
final class Runtime_Fingerprint {

	/**
	 * @return array<string, mixed>
	 */
	public static function snapshot( string $post_type, int $user_id ): array {
		$theme = wp_get_theme();
		if ( ! function_exists( 'get_plugins' ) && defined( 'ABSPATH' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$installed = function_exists( 'get_plugins' ) ? get_plugins() : array();
		$plugins   = array();
		foreach ( array_values( array_filter( (array) get_option( 'active_plugins', array() ), 'is_string' ) ) as $file ) {
			$plugins[] = array(
				'file'    => $file,
				'version' => isset( $installed[ $file ]['Version'] ) ? (string) $installed[ $file ]['Version'] : '',
			);
		}
		usort( $plugins, static fn( array $left, array $right ): int => strcmp( $left['file'], $right['file'] ) );
		$network_plugins = array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) );
		sort( $network_plugins, SORT_STRING );
		$mu_plugins = function_exists( 'get_mu_plugins' ) ? get_mu_plugins() : array();
		$mu_versions = array();
		foreach ( $mu_plugins as $file => $metadata ) {
			$mu_versions[] = array( 'file' => (string) $file, 'version' => (string) ( $metadata['Version'] ?? '' ) );
		}
		usort( $mu_versions, static fn( array $left, array $right ): int => strcmp( $left['file'], $right['file'] ) );
		$user = get_userdata( $user_id );

		$payload = array(
			'wordpressVersion' => (string) get_bloginfo( 'version' ),
			'pluginVersion'    => SITEPILOT_VERSION,
			'bridgeVersion'    => Feature::BRIDGE_VERSION,
			'theme'            => array(
				'stylesheet' => (string) $theme->get_stylesheet(),
				'version'    => (string) $theme->get( 'Version' ),
				'template'   => (string) $theme->get_template(),
				'parentVersion' => $theme->parent() ? (string) $theme->parent()->get( 'Version' ) : '',
				'mods'       => get_theme_mods(),
			),
			'activePlugins'    => $plugins,
			'networkPlugins'   => $network_plugins,
			'muPlugins'        => $mu_versions,
			'blockSettings'    => array(
				'useWidgetsBlockEditor' => (bool) get_option( 'use_widgets_block_editor', true ),
				'sidebarsWidgets'       => get_option( 'sidebars_widgets', array() ),
			),
			'postType'         => $post_type,
			'userId'           => $user_id,
			'userRoles'        => $user instanceof \WP_User ? array_values( $user->roles ) : array(),
			'userCapabilities' => $user instanceof \WP_User ? array_keys( array_filter( $user->allcaps ) ) : array(),
		);

		return array(
			'fingerprint' => hash( 'sha256', self::canonical_json( $payload ) ),
			'inputs'      => $payload,
		);
	}

	/**
	 * @param mixed $value Value to encode.
	 */
	public static function canonical_json( $value, bool $object_root = false ): string {
		$normalized = self::sort_value( $value, null, $object_root );
		// Keep the bytes identical to JSON.stringify(), including literal U+2028 and
		// U+2029. wp_json_encode() may intentionally escape those characters on
		// older WordPress/PHP combinations even when the PHP flag is supplied.
		$encoded    = json_encode( $normalized, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS );
		return is_string( $encoded ) ? $encoded : '';
	}

	/**
	 * @param mixed $value Value to normalize.
	 * @return mixed
	 */
	private static function sort_value( $value, ?string $key = null, bool $object_root = false ) {
		if ( ! is_array( $value ) ) {
			return $value;
		}
		$object_keys = array( 'attributes', 'target', 'postFields', 'expectedFields', 'requestedPostFields', 'sourceState', 'reviewArtifact', 'validation', 'contentPreservation', 'binding', 'source', 'data', 'style', 'layout', 'fields', 'seo', 'color', 'spacing', 'padding', 'margin' );
		if ( array() === $value && ( $object_root || ( null !== $key && in_array( $key, $object_keys, true ) ) ) ) {
			return (object) array();
		}
		if ( array_is_list( $value ) ) {
			return array_map( static fn( $child ) => self::sort_value( $child ), $value );
		}
		ksort( $value, SORT_STRING );
		foreach ( $value as $child_key => $child ) {
			$value[ $child_key ] = self::sort_value( $child, (string) $child_key );
		}
		return $value;
	}
}
