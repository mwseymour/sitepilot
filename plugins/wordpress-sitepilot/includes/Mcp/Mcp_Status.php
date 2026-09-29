<?php
/**
 * Tracks whether the SitePilot MCP server registered, and warns admins when it didn't.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

use WP\MCP\Core\McpAdapter;

/**
 * Records the outcome of MCP server registration and reports problems.
 *
 * The adapter only registers servers on REST requests, so the last outcome is
 * kept in an option for wp-admin to read. The option is written only when the
 * outcome changes, and each new failure is logged once.
 */
final class Mcp_Status {

	public const OPTION = 'sitepilot_mcp_status';

	public const ISSUE_ABILITIES_API_MISSING = 'abilities_api_missing';
	public const ISSUE_ADAPTER_MISSING       = 'adapter_missing';
	public const ISSUE_ADAPTER_INCOMPATIBLE  = 'adapter_incompatible';
	public const ISSUE_ADAPTER_INIT_SKIPPED  = 'adapter_init_skipped';
	public const ISSUE_REGISTRATION_FAILED   = 'registration_failed';

	/**
	 * Outcome recorded during this request, if any.
	 *
	 * @var array{ok: bool, issue: ?string, message: ?string, since: int}|null
	 */
	private static ?array $outcome = null;

	public static function register_hooks(): void {
		// After the adapter's own rest_api_init handler (priority 15).
		add_action( 'rest_api_init', array( self::class, 'check_after_rest_init' ), PHP_INT_MAX );
		add_action( 'admin_notices', array( self::class, 'render_admin_notice' ) );
	}

	public static function record_registered(): void {
		self::record( true, null, null );
	}

	public static function record_failure( string $issue, string $message ): void {
		self::record( false, $issue, $message );
	}

	/**
	 * Records why the server wasn't registered when Server_Registrar never ran.
	 */
	public static function check_after_rest_init(): void {
		if ( null !== self::$outcome ) {
			return;
		}

		if ( ! function_exists( 'wp_register_ability' ) ) {
			self::record_failure( self::ISSUE_ABILITIES_API_MISSING, 'wp_register_ability() is not defined.' );
		} elseif ( ! class_exists( McpAdapter::class ) ) {
			self::record_failure( self::ISSUE_ADAPTER_MISSING, McpAdapter::class . ' is not loaded.' );
		} else {
			self::record_failure( self::ISSUE_ADAPTER_INIT_SKIPPED, 'mcp_adapter_init did not run during rest_api_init.' );
		}
	}

	/**
	 * Current status: live prerequisite checks first, then the recorded outcome.
	 *
	 * @return array{ok: ?bool, issue: ?string, message: ?string, since: ?int}
	 */
	public static function current(): array {
		return self::evaluate(
			function_exists( 'wp_register_ability' ),
			class_exists( McpAdapter::class ),
			self::$outcome ?? self::stored()
		);
	}

	/**
	 * `ok` is null when no REST request has recorded an outcome yet.
	 *
	 * @param array{ok: bool, issue: ?string, message: ?string, since: int}|null $recorded Recorded outcome.
	 * @return array{ok: ?bool, issue: ?string, message: ?string, since: ?int}
	 */
	public static function evaluate( bool $abilities_api, bool $adapter_loaded, ?array $recorded ): array {
		if ( ! $abilities_api ) {
			return array(
				'ok'      => false,
				'issue'   => self::ISSUE_ABILITIES_API_MISSING,
				'message' => 'wp_register_ability() is not defined.',
				'since'   => null,
			);
		}

		if ( ! $adapter_loaded ) {
			return array(
				'ok'      => false,
				'issue'   => self::ISSUE_ADAPTER_MISSING,
				'message' => McpAdapter::class . ' is not loaded.',
				'since'   => null,
			);
		}

		return $recorded ?? array(
			'ok'      => null,
			'issue'   => null,
			'message' => null,
			'since'   => null,
		);
	}

	/**
	 * Public summary for the protocol endpoint. Leaves out messages, which can contain paths.
	 *
	 * @return array{registered: ?bool, issue: ?string}
	 */
	public static function for_protocol(): array {
		$status = self::current();
		return array(
			'registered' => $status['ok'],
			'issue'      => $status['issue'],
		);
	}

	/**
	 * Plain-language explanation of an issue for site admins.
	 */
	public static function describe( string $issue ): string {
		switch ( $issue ) {
			case self::ISSUE_ABILITIES_API_MISSING:
				return __( 'The WordPress Abilities API isn’t available. SitePilot needs WordPress 6.9 or later.', 'sitepilot' );
			case self::ISSUE_ADAPTER_MISSING:
				return __( 'The MCP Adapter library isn’t loaded. This copy of SitePilot may be an incomplete build, so reinstall it.', 'sitepilot' );
			case self::ISSUE_ADAPTER_INCOMPATIBLE:
				return __( 'The MCP Adapter that’s active doesn’t work with SitePilot. Another plugin may have loaded a different version first.', 'sitepilot' );
			case self::ISSUE_ADAPTER_INIT_SKIPPED:
				return __( 'The MCP Adapter loaded but didn’t run its setup, so SitePilot couldn’t register. Another plugin may have loaded a different MCP Adapter version first.', 'sitepilot' );
			case self::ISSUE_REGISTRATION_FAILED:
				return __( 'The MCP Adapter rejected the SitePilot MCP server.', 'sitepilot' );
			default:
				return __( 'The SitePilot MCP server isn’t registered.', 'sitepilot' );
		}
	}

	/**
	 * Which MCP Adapter is loaded, and whether it's the copy bundled with SitePilot.
	 *
	 * @return array{version: string, bundled: bool, file: string}|null
	 */
	public static function adapter_info(): ?array {
		if ( ! class_exists( McpAdapter::class ) ) {
			return null;
		}

		$file    = (string) ( new \ReflectionClass( McpAdapter::class ) )->getFileName();
		$vendor  = realpath( SITEPILOT_PLUGIN_DIR . 'vendor' );
		$real    = realpath( $file );
		$bundled = false !== $vendor && false !== $real && str_starts_with( $real, $vendor . DIRECTORY_SEPARATOR );

		return array(
			'version' => defined( McpAdapter::class . '::VERSION' ) ? (string) constant( McpAdapter::class . '::VERSION' ) : 'unknown',
			'bundled' => $bundled,
			'file'    => $file,
		);
	}

	public static function adapter_summary(): string {
		$info = self::adapter_info();
		if ( null === $info ) {
			return '';
		}

		return $info['bundled']
			/* translators: %s: MCP Adapter version. */
			? sprintf( __( 'MCP Adapter %s, bundled with SitePilot.', 'sitepilot' ), $info['version'] )
			/* translators: 1: MCP Adapter version, 2: file path. */
			: sprintf( __( 'MCP Adapter %1$s, loaded from %2$s.', 'sitepilot' ), $info['version'], $info['file'] );
	}

	public static function render_admin_notice(): void {
		if ( ! current_user_can( 'manage_options' ) || ! function_exists( 'get_current_screen' ) ) {
			return;
		}

		$screen = get_current_screen();
		if ( null === $screen || ! in_array( $screen->id, array( 'dashboard', 'plugins' ), true ) ) {
			return;
		}

		$status = self::current();
		if ( false !== $status['ok'] ) {
			return;
		}

		echo '<div class="notice notice-error"><p><strong>'
			. esc_html__( 'SitePilot can’t reach its MCP tools, so the desktop app can’t work with this site.', 'sitepilot' )
			. '</strong> ' . esc_html( self::describe( (string) $status['issue'] ) ) . '</p><p>'
			. '<a href="' . esc_url( admin_url( 'options-general.php?page=sitepilot' ) ) . '">'
			. esc_html__( 'See details in Settings → SitePilot', 'sitepilot' ) . '</a></p></div>';
	}

	/**
	 * @return array{ok: bool, issue: ?string, message: ?string, since: int}|null
	 */
	private static function stored(): ?array {
		$stored = get_option( self::OPTION, null );
		if ( ! is_array( $stored ) || ! isset( $stored['ok'], $stored['since'] ) || ! is_bool( $stored['ok'] ) ) {
			return null;
		}

		return array(
			'ok'      => $stored['ok'],
			'issue'   => isset( $stored['issue'] ) ? (string) $stored['issue'] : null,
			'message' => isset( $stored['message'] ) ? (string) $stored['message'] : null,
			'since'   => (int) $stored['since'],
		);
	}

	private static function record( bool $ok, ?string $issue, ?string $message ): void {
		$stored = self::stored();

		if ( null !== $stored && $stored['ok'] === $ok && $stored['issue'] === $issue && $stored['message'] === $message ) {
			self::$outcome = $stored;
			return;
		}

		self::$outcome = array(
			'ok'      => $ok,
			'issue'   => $issue,
			'message' => $message,
			'since'   => time(),
		);
		update_option( self::OPTION, self::$outcome, false );

		if ( ! $ok ) {
			error_log( sprintf( '[sitepilot] SitePilot MCP server is not registered (%s): %s', (string) $issue, (string) $message ) );
		}
	}

	/**
	 * Clears the per-request outcome. For tests.
	 */
	public static function reset_request_state(): void {
		self::$outcome = null;
	}
}
