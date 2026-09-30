<?php
/**
 * Plugin Name: SitePilot render-check E2E fault
 * Description: Test only. On the exact local E2E host, makes any block whose markup contains SITEPILOT_RENDER_BOOM throw while rendering, except in wp-admin and core /wp/v2/ REST responses. That models a template that breaks the page but not the editor. tests/e2e/v2-render-check.ts installs and removes it.
 */

declare( strict_types = 1 );

$sitepilot_e2e_host = isset( $_SERVER['HTTP_HOST'] ) ? strtolower( trim( (string) $_SERVER['HTTP_HOST'] ) ) : '';

if ( 'test.localhost:8890' === $sitepilot_e2e_host ) {
	add_filter(
		'render_block',
		static function ( string $content ): string {
			if ( ! str_contains( $content, 'SITEPILOT_RENDER_BOOM' ) ) {
				return $content;
			}
			// The editor must keep working: its page preloads REST data
			// in-process, and it then calls core /wp/v2/ routes.
			$rest_route = isset( $GLOBALS['wp'] ) ? (string) ( $GLOBALS['wp']->query_vars['rest_route'] ?? '' ) : '';
			if ( is_admin() || str_starts_with( $rest_route, '/wp/v2/' ) ) {
				return $content;
			}
			throw new RuntimeException( 'SitePilot E2E: this block is set to fail rendering.' );
		}
	);
}

unset( $sitepilot_e2e_host );
