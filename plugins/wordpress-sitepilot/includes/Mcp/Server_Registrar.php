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
 * Exposes SitePilot's read-only abilities on the SitePilot MCP route. Content
 * changes go through the signed v2 routes instead.
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
			Mcp_Status::record_failure(
				Mcp_Status::ISSUE_ADAPTER_INCOMPATIBLE,
				sprintf( 'mcp_adapter_init passed %s instead of %s.', get_debug_type( $adapter ), McpAdapter::class )
			);
			return;
		}

		try {
			$result = self::create_server( $adapter );
		} catch ( \Throwable $e ) {
			// A different adapter version can change create_server()'s signature.
			Mcp_Status::record_failure( Mcp_Status::ISSUE_ADAPTER_INCOMPATIBLE, get_class( $e ) . ': ' . $e->getMessage() );
			return;
		}

		if ( is_wp_error( $result ) ) {
			Mcp_Status::record_failure( Mcp_Status::ISSUE_REGISTRATION_FAILED, $result->get_error_message() );
			return;
		}

		Mcp_Status::record_registered();
	}

	/**
	 * @param McpAdapter $adapter Registry.
	 * @return mixed McpAdapter on success, WP_Error on failure.
	 */
	private static function create_server( McpAdapter $adapter ) {
		return $adapter->create_server(
			'sitepilot-bridge',
			'sitepilot',
			'mcp',
			__( 'SitePilot MCP', 'sitepilot' ),
			__( 'Read-only SitePilot lookups for the desktop app.', 'sitepilot' ),
			SITEPILOT_VERSION,
			array( HttpTransport::class ),
			ErrorLogMcpErrorHandler::class,
			NullMcpObservabilityHandler::class,
			array(
				'sitepilot/ping',
				'sitepilot/site-discovery',
				'sitepilot/find-posts',
				'sitepilot/get-post',
				'sitepilot/list-terms',
			),
			array(),
			array(),
			array( Mcp_Permission::class, 'check_access' )
		);
	}
}
