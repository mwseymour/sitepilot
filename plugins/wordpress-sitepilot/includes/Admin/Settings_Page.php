<?php
/**
 * Minimal settings page with protocol summary.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Admin;

use SitePilot\Mcp\Mcp_Status;
use SitePilot\Registration\Registration_Code;
use SitePilot\Registration\Store;
use SitePilot\V2\Feature;

/**
 * Registers Settings → SitePilot.
 */
final class Settings_Page {

	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'register_menu' ) );
		add_action( 'admin_post_sitepilot_reset_code', array( self::class, 'handle_reset_code' ) );
		add_action( 'admin_post_sitepilot_revoke_site', array( self::class, 'handle_revoke_site' ) );
	}

	public static function handle_reset_code(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( 'sitepilot_reset_code' );
		Registration_Code::reset();
		self::redirect_with_notice( 'code_reset' );
	}

	public static function handle_revoke_site(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You are not allowed to do that.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}
		$site_id = isset( $_POST['site_id'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['site_id'] ) ) : '';
		check_admin_referer( 'sitepilot_revoke_site_' . $site_id );
		Store::delete_site( $site_id );
		self::redirect_with_notice( 'revoked' );
	}

	private static function redirect_with_notice( string $notice ): void {
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'             => 'sitepilot',
					'sitepilot_notice' => $notice,
				),
				admin_url( 'options-general.php' )
			)
		);
		exit;
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
		$reg_code     = Registration_Code::current();

		echo '<div class="wrap">';
		echo '<h1>' . esc_html__( 'SitePilot', 'sitepilot' ) . '</h1>';
		self::render_notice();
		echo '<p>' . esc_html__( 'SitePilot connects this site to the SitePilot desktop app. Protocol metadata and MCP endpoints are exposed only to authenticated users where required.', 'sitepilot' ) . '</p>';
		echo '<h2>' . esc_html__( 'Endpoints', 'sitepilot' ) . '</h2>';
		echo '<ul>';
		echo '<li><label>' . esc_html__( 'Health', 'sitepilot' ) . '</label> <code>' . esc_html( $health_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'Protocol', 'sitepilot' ) . '</label> <code>' . esc_html( $protocol_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'MCP (HTTP)', 'sitepilot' ) . '</label> <code>' . esc_html( $mcp_url ) . '</code></li>';
		echo '<li><label>' . esc_html__( 'Register site (POST)', 'sitepilot' ) . '</label> <code>' . esc_html( $register_url ) . '</code></li>';
		echo '</ul>';
		self::render_mcp_status();
		echo '<h2>' . esc_html__( 'Registration code', 'sitepilot' ) . '</h2>';
		echo '<p>' . esc_html__( 'Enter this code in SitePilot when you add this site (HTTPS only). Each code works once: a new one appears here after every registration.', 'sitepilot' ) . '</p>';
		echo '<details><summary>' . esc_html__( 'Show code', 'sitepilot' ) . '</summary><p><code style="font-size:14px;">' . esc_html( $reg_code ) . '</code></p></details>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'sitepilot_reset_code' );
		echo '<input type="hidden" name="action" value="sitepilot_reset_code" />';
		echo '<p><button type="submit" class="button">' . esc_html__( 'Reset code', 'sitepilot' ) . '</button></p>';
		echo '</form>';
		self::render_registered_clients();
		echo '<p>' . esc_html__( 'SitePilot protocol version:', 'sitepilot' ) . ' <strong>' . esc_html( SITEPILOT_PROTOCOL_VERSION ) . '</strong></p>';
		echo '<h2>' . esc_html__( 'Content changes', 'sitepilot' ) . '</h2>';
		echo '<p><strong>' . esc_html( Feature::enabled() ? __( 'On: SitePilot can change content on this site', 'sitepilot' ) : __( 'Off: SITEPILOT_V2_ENABLED is false, so SitePilot can’t change content on this site', 'sitepilot' ) ) . '</strong></p>';
		echo '<p>' . esc_html__( 'To stop SitePilot changing content on this site, define SITEPILOT_V2_ENABLED as false in wp-config.php. Lookups still work.', 'sitepilot' ) . '</p>';
		echo '</div>';
	}

	private static function render_notice(): void {
		$notice = isset( $_GET['sitepilot_notice'] ) ? sanitize_key( wp_unslash( (string) $_GET['sitepilot_notice'] ) ) : '';
		$messages = array(
			'code_reset' => __( 'Registration code reset. The old code no longer works.', 'sitepilot' ),
			'revoked'    => __( 'Client revoked. It can no longer sign requests to this site.', 'sitepilot' ),
		);
		if ( isset( $messages[ $notice ] ) ) {
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( $messages[ $notice ] ) . '</p></div>';
		}
	}

	private static function render_registered_clients(): void {
		$sites = Store::list_sites();
		echo '<h2>' . esc_html__( 'Registered SitePilot clients', 'sitepilot' ) . '</h2>';
		if ( array() === $sites ) {
			echo '<p>' . esc_html__( 'None yet.', 'sitepilot' ) . '</p>';
			return;
		}
		echo '<table class="widefat striped"><thead><tr>';
		foreach ( array( __( 'Name', 'sitepilot' ), __( 'Site ID', 'sitepilot' ), __( 'Acts as', 'sitepilot' ), __( 'Registered', 'sitepilot' ), '' ) as $heading ) {
			echo '<th>' . esc_html( $heading ) . '</th>';
		}
		echo '</tr></thead><tbody>';
		foreach ( $sites as $site ) {
			$user = $site['user_id'] > 0 ? get_user_by( 'id', $site['user_id'] ) : false;
			echo '<tr>';
			echo '<td>' . esc_html( '' !== $site['name'] ? $site['name'] : __( '(unnamed)', 'sitepilot' ) ) . '</td>';
			echo '<td>' . esc_html( substr( $site['site_id'], 0, 8 ) ) . '…</td>';
			echo '<td>' . esc_html( $user instanceof \WP_User ? $user->user_login : __( 'No user: signed requests are refused', 'sitepilot' ) ) . '</td>';
			echo '<td>' . esc_html( $site['registered_at'] > 0 ? wp_date( get_option( 'date_format' ), $site['registered_at'] ) : __( 'Before 0.2.0', 'sitepilot' ) ) . '</td>';
			echo '<td><form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			wp_nonce_field( 'sitepilot_revoke_site_' . $site['site_id'] );
			echo '<input type="hidden" name="action" value="sitepilot_revoke_site" />';
			echo '<input type="hidden" name="site_id" value="' . esc_attr( $site['site_id'] ) . '" />';
			echo '<button type="submit" class="button button-link-delete">' . esc_html__( 'Revoke', 'sitepilot' ) . '</button>';
			echo '</form></td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
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
