<?php
/**
 * Registers read-only SitePilot abilities for the MCP adapter.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

/**
 * Registers WordPress abilities (requires WP 6.9+ Abilities API).
 */
final class Abilities_Registrar {

	public static function register_hooks(): void {
		add_action( 'wp_abilities_api_categories_init', array( self::class, 'register_category' ), 5 );
		add_action( 'wp_abilities_api_init', array( self::class, 'register_abilities' ), 5 );
	}

	public static function register_category(): void {
		if ( ! function_exists( 'wp_register_ability_category' ) ) {
			return;
		}

		wp_register_ability_category(
			'sitepilot',
			array(
				'label'       => __( 'SitePilot', 'sitepilot' ),
				'description' => __( 'Read-only bridge tools for the SitePilot desktop app.', 'sitepilot' ),
			)
		);
	}

	public static function register_abilities(): void {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}

		wp_register_ability(
			'sitepilot/ping',
			array(
				'label'               => __( 'Ping', 'sitepilot' ),
				'description'         => __( 'Health check for MCP connectivity.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'             => array( 'type' => 'boolean' ),
						'plugin_version' => array( 'type' => 'string' ),
					),
					'required'   => array( 'ok', 'plugin_version' ),
				),
				'execute_callback'    => static function ( array $input ) {
					unset( $input );
					return array(
						'ok'             => true,
						'plugin_version' => SITEPILOT_VERSION,
					);
				},
				'permission_callback' => static function ( $input = array() ) {
					unset( $input );
					return current_user_can( 'read' );
				},
				'meta'                => array(
					'annotations' => array(
						'readonly'    => true,
						'destructive' => false,
						'idempotent'  => true,
					),
				),
			)
		);

		wp_register_ability(
			'sitepilot/site-summary',
			array(
				'label'               => __( 'Site summary', 'sitepilot' ),
				'description'         => __( 'Returns public site identity metadata (no secrets).', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'name'       => array( 'type' => 'string' ),
						'home_url'   => array( 'type' => 'string', 'format' => 'uri' ),
						'wp_version' => array( 'type' => 'string' ),
					),
					'required'   => array( 'name', 'home_url', 'wp_version' ),
				),
				'execute_callback'    => static function ( array $input ) {
					unset( $input );
					return array(
						'name'       => get_bloginfo( 'name' ),
						'home_url'   => home_url( '/' ),
						'wp_version' => get_bloginfo( 'version' ),
					);
				},
				'permission_callback' => static function ( $input = array() ) {
					unset( $input );
					return current_user_can( 'read' );
				},
				'meta'                => array(
					'annotations' => array(
						'readonly'    => true,
						'destructive' => false,
						'idempotent'  => true,
					),
				),
			)
		);
	}
}
