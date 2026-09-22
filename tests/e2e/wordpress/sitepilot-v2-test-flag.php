<?php
/**
 * Plugin Name: SitePilot v2 local E2E gate
 * Description: Enables the disabled-by-default v2 bridge only on the exact local E2E host.
 */

declare( strict_types = 1 );

$sitepilot_e2e_host = isset( $_SERVER['HTTP_HOST'] ) ? strtolower( trim( (string) $_SERVER['HTTP_HOST'] ) ) : '';
$sitepilot_e2e_remote = isset( $_SERVER['REMOTE_ADDR'] ) ? trim( (string) $_SERVER['REMOTE_ADDR'] ) : '';

if ( 'test.localhost:8890' === $sitepilot_e2e_host && in_array( $sitepilot_e2e_remote, array( '127.0.0.1', '::1' ), true ) && ! defined( 'SITEPILOT_V2_ENABLED' ) ) {
	define( 'SITEPILOT_V2_ENABLED', true );
}

unset( $sitepilot_e2e_host, $sitepilot_e2e_remote );
