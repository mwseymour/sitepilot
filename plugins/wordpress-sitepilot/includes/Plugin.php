<?php
/**
 * Core plugin bootstrap.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot;

use SitePilot\Admin\Settings_Page;
use SitePilot\Mcp\Abilities_Registrar;
use SitePilot\Mcp\Write_Abilities;
use SitePilot\Mcp\Server_Registrar;
use SitePilot\Security\Signed_Request_Verifier;
use SitePilot\Rest\Protocol_Routes;
use SitePilot\Rest\Registration_Routes;

/**
 * Loads REST routes, admin UI, MCP adapter integration, and abilities.
 */
final class Plugin {

	public static function init(): void {
		add_action( 'plugins_loaded', array( self::class, 'on_plugins_loaded' ) );
	}

	public static function on_plugins_loaded(): void {
		Protocol_Routes::register();
		Registration_Routes::register();
		Settings_Page::register();

		add_action( 'shutdown', array( Signed_Request_Verifier::class, 'reset_request_context' ), 999 );

		if ( class_exists( \WP\MCP\Core\McpAdapter::class ) ) {
			\WP\MCP\Core\McpAdapter::instance();
		}

		if ( function_exists( 'wp_register_ability' ) ) {
			Abilities_Registrar::register_hooks();
			Write_Abilities::register_hooks();
			Server_Registrar::register_hooks();
		}
	}
}
