<?php
/**
 * Sign in with WordPress: the site's own login proves who someone is.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Auth;

use SitePilot\Admin\Brand;
use SitePilot\Registration\Store;

/**
 * A hosted SitePilot sends people to admin-post.php?action=sitepilot_sign_in
 * with its site ID and a one-use state. After the normal WordPress login and
 * a confirmation, the plugin sends them back to that client's registered
 * callback with a short-lived assertion of who they are, signed with the
 * client's shared secret. Nothing is sent anywhere else.
 */
final class WordPress_Sign_In {

	public const SCHEMA = 'sitepilot.wordpress-sign-in/v1';
	public const TTL    = 120;

	/** What the assertion reports, so SitePilot can set the person's role. */
	private const CAPABILITIES = array( 'read', 'edit_posts', 'publish_posts', 'edit_others_posts', 'manage_options' );

	public static function register_hooks(): void {
		add_action( 'admin_post_nopriv_sitepilot_sign_in', array( self::class, 'require_login' ) );
		add_action( 'admin_post_sitepilot_sign_in', array( self::class, 'confirm_page' ) );
		add_action( 'admin_post_sitepilot_sign_in_confirm', array( self::class, 'confirm' ) );
	}

	/** https, or http on localhost for development. */
	public static function is_allowed_callback( string $url ): bool {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || isset( $parts['user'] ) || isset( $parts['fragment'] ) ) {
			return false;
		}
		$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
		$host   = strtolower( (string) $parts['host'] );
		return 'https' === $scheme
			|| ( 'http' === $scheme && in_array( $host, array( 'localhost', '127.0.0.1', '[::1]' ), true ) );
	}

	public static function require_login(): void {
		auth_redirect();
	}

	public static function confirm_page(): void {
		[ $site_id, $state, $client ] = self::request_or_die( $_GET ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$user   = wp_get_current_user();
		$cancel = add_query_arg(
			array(
				'error' => 'access_denied',
				'state' => rawurlencode( $state ),
			),
			$client['sign_in_callback']
		);
		$name   = '' !== (string) ( $client['name'] ?? '' ) ? (string) $client['name'] : 'SitePilot';
		header( 'Content-Type: text/html; charset=utf-8' );
		header( 'X-Frame-Options: DENY' );
		header( 'Cache-Control: no-store' );
		echo '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' . esc_html__( 'Sign in to SitePilot', 'sitepilot' ) . '</title>';
		echo '<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2327}button,a.button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head><body>';
		echo Brand::heading( __( 'Sign in to SitePilot', 'sitepilot' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Brand::heading escapes the text.
		/* translators: 1: the SitePilot client's name, 2: the WordPress user's display name, 3: their login. */
		echo '<p>' . esc_html( sprintf( __( '%1$s wants to sign you in as %2$s (%3$s).', 'sitepilot' ), $name, $user->display_name, $user->user_login ) ) . '</p>';
		echo '<p>' . esc_html__( 'It will see your name, email address and what you can do on this site, such as whether you can publish.', 'sitepilot' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( self::nonce_action( $site_id, $state ) );
		echo '<input type="hidden" name="action" value="sitepilot_sign_in_confirm">';
		echo '<input type="hidden" name="site_id" value="' . esc_attr( $site_id ) . '">';
		echo '<input type="hidden" name="state" value="' . esc_attr( $state ) . '">';
		echo '<button type="submit">' . esc_html__( 'Continue', 'sitepilot' ) . '</button>';
		echo '<a class="button" href="' . esc_url( $cancel ) . '">' . esc_html__( 'Cancel', 'sitepilot' ) . '</a>';
		echo '</form></body></html>';
		exit;
	}

	public static function confirm(): void {
		[ $site_id, $state, $client ] = self::request_or_die( $_POST ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( self::nonce_action( $site_id, $state ) );
		$assertion = self::assertion( $site_id, $state, wp_get_current_user(), time() );
		$location  = add_query_arg(
			array(
				'assertion' => $assertion['payload'],
				'signature' => $assertion['signature'],
			),
			$client['sign_in_callback']
		);
		// The callback was checked when the client registered.
		wp_redirect( $location ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect
		exit;
	}

	/**
	 * The signed assertion: base64url JSON and its HMAC-SHA256 under the
	 * client's shared secret.
	 *
	 * @return array{payload: string, signature: string}
	 */
	public static function assertion( string $site_id, string $state, \WP_User $user, int $now ): array {
		$client = Store::get_row( $site_id );
		$secret = base64_decode( (string) ( $client['secret'] ?? '' ), true );
		if ( ! is_string( $secret ) || '' === $secret ) {
			throw new \RuntimeException( 'This SitePilot client has no shared secret.' );
		}
		$capabilities = array();
		foreach ( self::CAPABILITIES as $capability ) {
			$capabilities[ $capability ] = user_can( $user, $capability );
		}
		$payload = self::base64url(
			(string) wp_json_encode(
				array(
					'schema'       => self::SCHEMA,
					'siteId'       => $site_id,
					'state'        => $state,
					'nonce'        => bin2hex( random_bytes( 16 ) ),
					'issuedAt'     => $now,
					'expiresAt'    => $now + self::TTL,
					'user'         => array(
						'id'          => (int) $user->ID,
						'login'       => (string) $user->user_login,
						'email'       => (string) $user->user_email,
						'displayName' => (string) $user->display_name,
						'roles'       => array_values( (array) $user->roles ),
					),
					'capabilities' => $capabilities,
				)
			)
		);
		return array(
			'payload'   => $payload,
			'signature' => self::base64url( hash_hmac( 'sha256', self::SCHEMA . "\n" . $payload, $secret, true ) ),
		);
	}

	/**
	 * @param array<string, mixed> $input Query or form values.
	 * @return array{0: string, 1: string, 2: array<string, mixed>}
	 */
	private static function request_or_die( array $input ): array {
		$site_id = isset( $input['site_id'] ) ? sanitize_text_field( wp_unslash( (string) $input['site_id'] ) ) : '';
		$state   = isset( $input['state'] ) ? (string) wp_unslash( (string) $input['state'] ) : '';
		$client  = '' !== $site_id ? Store::get_row( $site_id ) : null;
		if ( ! preg_match( '/^[A-Za-z0-9_-]{16,200}$/', $state ) || ! is_array( $client ) || ! self::is_allowed_callback( (string) ( $client['sign_in_callback'] ?? '' ) ) ) {
			wp_die( esc_html__( 'This sign-in link is invalid. Start again from SitePilot.', 'sitepilot' ), '', array( 'response' => 400 ) );
		}
		return array( $site_id, $state, $client );
	}

	private static function nonce_action( string $site_id, string $state ): string {
		return 'sitepilot_sign_in_' . $site_id . '_' . $state;
	}

	private static function base64url( string $bytes ): string {
		return rtrim( strtr( base64_encode( $bytes ), '+/', '-_' ), '=' );
	}
}
