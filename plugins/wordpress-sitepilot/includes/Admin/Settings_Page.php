<?php
/**
 * Minimal settings page with protocol summary.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Admin;

use SitePilot\Mcp\Mcp_Status;
use SitePilot\Registration\Store;
use SitePilot\V2\Feature;

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
		$register_url = rest_url( 'sitepilot/v1/register' );
		$reg_code     = Store::ensure_registration_code();

		echo '<div class="wrap">';
		echo '<h1>' . esc_html__( 'SitePilot', 'sitepilot' ) . '</h1>';
		echo '<p>' . esc_html__( 'SitePilot connects this site to the SitePilot desktop app. Protocol metadata and MCP endpoints are exposed only to authenticated users where required.', 'sitepilot' ) . '</p>';
		echo '<h2>' . esc_html__( 'Endpoints', 'sitepilot' ) . '</h2>';
		echo '<ul>';
		echo '<li><label>' . esc_html__( 'Health', 'sitepilot' ) . '</label> <code>' . esc_html( $health_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'Protocol', 'sitepilot' ) . '</label> <code>' . esc_html( $protocol_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'MCP (HTTP)', 'sitepilot' ) . '</label> <code>' . esc_html( $mcp_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'Register site (POST)', 'sitepilot' ) . '</label> <code>' . esc_html( $register_url ) . '</code></li>';
		echo '</ul>';
		self::render_mcp_status();
		echo '<h2>' . esc_html__( 'Desktop registration code', 'sitepilot' ) . '</h2>';
		echo '<p>' . esc_html__( 'Enter this one-time code in the SitePilot desktop app when registering this site (HTTPS only).', 'sitepilot' ) . '</p>';
		echo '<p><code style="font-size:14px;">' . esc_html( $reg_code ) . '</code></p>';
		echo '<p>' . esc_html__( 'SitePilot protocol version:', 'sitepilot' ) . ' <strong>' . esc_html( SITEPILOT_PROTOCOL_VERSION ) . '</strong></p>';
		echo '<h2>' . esc_html__( 'Content changes', 'sitepilot' ) . '</h2>';
		echo '<p><strong>' . esc_html( Feature::enabled() ? __( 'On: SitePilot can change content on this site', 'sitepilot' ) : __( 'Off: SITEPILOT_V2_ENABLED is false, so SitePilot can’t change content on this site', 'sitepilot' ) ) . '</strong></p>';
		echo '<p>' . esc_html__( 'To stop SitePilot changing content on this site, define SITEPILOT_V2_ENABLED as false in wp-config.php. Lookups still work.', 'sitepilot' ) . '</p>';
		echo '</div>';
	}

	private static function render_mcp_status(): void {
		$status = Mcp_Status::current();

		echo '<h2>' . esc_html__( 'MCP server', 'sitepilot' ) . '</h2>';

		if ( true === $status['ok'] ) {
			echo '<p><strong>' . esc_html__( 'Registered', 'sitepilot' ) . '</strong></p>';
		} elseif ( null === $status['ok'] ) {
			echo '<p><strong>' . esc_html__( 'Not checked yet', 'sitepilot' ) . '</strong></p>';
			echo '<p>' . esc_html__( 'SitePilot checks the MCP server on the next REST request, for example when the desktop app connects.', 'sitepilot' ) . '</p>';
		} else {
			echo '<div class="notice notice-error inline"><p><strong>' . esc_html__( 'Not registered', 'sitepilot' ) . '</strong> '
				. esc_html( Mcp_Status::describe( (string) $status['issue'] ) ) . '</p>';
			if ( null !== $status['message'] ) {
				echo '<p>' . esc_html__( 'Details:', 'sitepilot' ) . ' <code>' . esc_html( $status['message'] ) . '</code></p>';
			}
			if ( null !== $status['since'] ) {
				/* translators: %s: date and time. */
				echo '<p>' . esc_html( sprintf( __( 'First seen %s.', 'sitepilot' ), wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $status['since'] ) ) ) . '</p>';
			}
			echo '</div>';
		}

		$adapter = Mcp_Status::adapter_summary();
		if ( '' !== $adapter ) {
			echo '<p>' . esc_html( $adapter ) . '</p>';
		}
	}
}
