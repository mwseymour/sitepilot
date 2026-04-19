<?php
/**
 * Registers the custom SitePilot MCP HTTP server.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

use WP\MCP\Core\McpAdapter;
use WP\MCP\Infrastructure\ErrorHandling\ErrorLogMcpErrorHandler;
use WP\MCP\Infrastructure\Observability\NullMcpObservabilityHandler;
use SitePilot\Mcp\Mcp_Permission;
use WP\MCP\Transport\HttpTransport;

/**
 * Exposes SitePilot read-only abilities on the SitePilot MCP route.
 */
final class Server_Registrar {

	public static function register_hooks(): void {
		add_action( 'mcp_adapter_init', array( self::class, 'register_server' ), 100 );
	}

	/**
	 * @param McpAdapter $adapter Registry.
	 */
	public static function register_server( $adapter ): void {
		if ( ! $adapter instanceof McpAdapter ) {
			return;
		}

		$result = $adapter->create_server(
			'sitepilot-bridge',
			'sitepilot',
			'mcp',
			__( 'SitePilot MCP', 'sitepilot' ),
			__( 'Read-only SitePilot tools for the desktop app.', 'sitepilot' ),
			SITEPILOT_VERSION,
			array( HttpTransport::class ),
			ErrorLogMcpErrorHandler::class,
			NullMcpObservabilityHandler::class,
			array(
				'sitepilot/ping',
				'sitepilot/site-summary',
				'sitepilot/site-discovery',
			),
			array(),
			array(),
			array( Mcp_Permission::class, 'check_access' )
		);

		if ( is_wp_error( $result ) ) {
			error_log(
				'[sitepilot] MCP server registration failed: ' . $result->get_error_message()
			);
		}
	}
}
