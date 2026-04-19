<?php
/**
 * Minimal settings page with protocol summary.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Admin;

/**
 * Registers Settings → SitePilot.
 */
final class Settings_Page {

	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'register_menu' ) );
	}

	public static function register_menu(): void {
		add_options_page(
			__( 'SitePilot', 'sitepilot' ),
			__( 'SitePilot', 'sitepilot' ),
			'manage_options',
			'sitepilot',
			array( self::class, 'render' )
		);
	}

	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$health_url   = rest_url( 'sitepilot/v1/health' );
		$protocol_url = rest_url( 'sitepilot/v1/protocol' );
		$mcp_url      = rest_url( 'sitepilot/mcp' );

		echo '<div class="wrap">';
		echo '<h1>' . esc_html__( 'SitePilot', 'sitepilot' ) . '</h1>';
		echo '<p>' . esc_html__( 'SitePilot connects this site to the SitePilot desktop app. Protocol metadata and MCP endpoints are exposed only to authenticated users where required.', 'sitepilot' ) . '</p>';
		echo '<h2>' . esc_html__( 'Endpoints', 'sitepilot' ) . '</h2>';
		echo '<ul>';
		echo '<li><label>' . esc_html__( 'Health', 'sitepilot' ) . '</label> <code>' . esc_html( $health_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'Protocol', 'sitepilot' ) . '</label> <code>' . esc_html( $protocol_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'MCP (HTTP)', 'sitepilot' ) . '</label> <code>' . esc_html( $mcp_url ) . '</code></li>';
		echo '</ul>';
		echo '<p>' . esc_html__( 'SitePilot protocol version:', 'sitepilot' ) . ' <strong>' . esc_html( SITEPILOT_PROTOCOL_VERSION ) . '</strong></p>';
		echo '</div>';
	}
}
