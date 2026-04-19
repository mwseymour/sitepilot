<?php
/**
 * Collects read-only discovery data for the desktop app (no secrets).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

/**
 * Builds a structured discovery payload for `sitepilot/site-discovery`.
 */
final class Site_Discovery {

	/**
	 * @return array<string, mixed>
	 */
	public static function collect(): array {
		$post_types = array();
		foreach ( get_post_types( array( 'public' => true ), 'objects' ) as $slug => $obj ) {
			$post_types[ $slug ] = array(
				'label'  => $obj->label,
				'public' => (bool) $obj->public,
			);
		}

		$taxonomies = array();
		foreach ( get_taxonomies( array( 'public' => true ), 'objects' ) as $slug => $obj ) {
			$taxonomies[ $slug ] = array(
				'label' => $obj->label,
			);
		}

		$menus = array();
		foreach ( wp_get_nav_menus() as $menu ) {
			$menus[] = array(
				'id'   => (int) $menu->term_id,
				'name' => $menu->name,
				'slug' => $menu->slug,
			);
		}

		$theme = wp_get_theme();
		$active = array_values( (array) get_option( 'active_plugins', array() ) );

		$warnings = array();
		if ( version_compare( (string) PHP_VERSION, '8.1.0', '<' ) ) {
			$warnings[] = 'PHP version is below 8.1; SitePilot recommends PHP 8.1+.';
		}

		return array(
			'wordpress' => array(
				'version' => get_bloginfo( 'version' ),
				'language' => get_bloginfo( 'language' ),
				'timezone' => wp_timezone_string(),
			),
			'site'      => array(
				'name'     => get_bloginfo( 'name' ),
				'tagline'  => get_bloginfo( 'description' ),
				'home_url' => home_url( '/' ),
			),
			'theme'     => array(
				'name'    => $theme->get( 'Name' ),
				'version' => $theme->get( 'Version' ),
				'slug'    => $theme->get_stylesheet(),
			),
			'post_types' => $post_types,
			'taxonomies' => $taxonomies,
			'nav_menus'  => $menus,
			'active_plugins' => $active,
			'seo'        => self::detect_seo_plugins(),
			'warnings'   => $warnings,
		);
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function detect_seo_plugins(): array {
		$active = (array) get_option( 'active_plugins', array() );
		$found  = array();
		foreach ( $active as $file ) {
			if ( ! is_string( $file ) ) {
				continue;
			}
			if ( str_contains( $file, 'wordpress-seo' ) ) {
				$found['yoast_seo'] = true;
			}
			if ( str_contains( $file, 'seo-by-rank-math' ) ) {
				$found['rank_math'] = true;
			}
			if ( str_contains( $file, 'all-in-one-seo-pack' ) ) {
				$found['aioseo'] = true;
			}
		}
		return $found;
	}
}
