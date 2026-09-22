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
use SitePilot\Rest\V2_Routes;
use SitePilot\V2\Editor_Session;
use SitePilot\V2\Commit_Service;
use SitePilot\V2\Media_Service;

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
		V2_Routes::register();
		Settings_Page::register();
		Editor_Session::register_enforcement_hooks();
		Commit_Service::register_hooks();
		Media_Service::register_hooks();

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
