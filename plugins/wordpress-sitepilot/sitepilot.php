<?php
/**
 * Plugin Name:       SitePilot
 * Description:       Companion bridge for the SitePilot desktop app — protocol metadata, MCP tools, and future site execution.
 * Version:           0.1.0
 * Requires at least: 6.9
 * Requires PHP:       8.1
 * Author:            SitePilot
 * License:           GPL-2.0-or-later
 * Text Domain:       sitepilot
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SITEPILOT_VERSION', '0.1.0' );
define( 'SITEPILOT_PROTOCOL_VERSION', '1.0.0' );
define( 'SITEPILOT_PLUGIN_FILE', __FILE__ );
define( 'SITEPILOT_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

if ( is_readable( SITEPILOT_PLUGIN_DIR . 'vendor/autoload.php' ) ) {
	require_once SITEPILOT_PLUGIN_DIR . 'vendor/autoload.php';
}

require_once SITEPILOT_PLUGIN_DIR . 'includes/Plugin.php';

register_activation_hook(
	SITEPILOT_PLUGIN_FILE,
	static function (): void {
		if ( class_exists( \SitePilot\Registration\Store::class ) ) {
			\SitePilot\Registration\Store::ensure_registration_code();
		}
	}
);

SitePilot\Plugin::init();
