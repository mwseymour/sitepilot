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

		wp_register_ability(
			'sitepilot/site-discovery',
			array(
				'label'               => __( 'Site discovery', 'sitepilot' ),
				'description'         => __( 'Returns post types, taxonomies, menus, theme, plugins, and SEO hints for discovery snapshots.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'wordpress' => array( 'type' => 'object' ),
						'site'      => array( 'type' => 'object' ),
						'theme'     => array( 'type' => 'object' ),
						'post_types' => array( 'type' => 'object' ),
						'taxonomies' => array( 'type' => 'object' ),
						'nav_menus'  => array( 'type' => 'array' ),
						'active_plugins' => array( 'type' => 'array' ),
						'seo'        => array( 'type' => 'object' ),
						'warnings'   => array( 'type' => 'array' ),
					),
					'required'   => array( 'wordpress', 'site', 'theme', 'post_types', 'taxonomies', 'nav_menus', 'active_plugins', 'seo', 'warnings' ),
				),
				'execute_callback'    => static function ( array $input ) {
					unset( $input );
					return Site_Discovery::collect();
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
			'sitepilot/find-posts',
			array(
				'label'               => __( 'Find posts', 'sitepilot' ),
				'description'         => __( 'Finds posts by status, slug, title, search text, category, and post type.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_type' => array( 'type' => 'string', 'default' => 'any' ),
						'status'    => array( 'type' => 'string', 'default' => 'any' ),
						'slug'      => array( 'type' => 'string' ),
						'title'     => array( 'type' => 'string' ),
						'search'    => array( 'type' => 'string' ),
						'category'  => array( 'type' => 'string' ),
						'limit'     => array(
							'type'    => 'integer',
							'minimum' => 1,
							'maximum' => 20,
							'default' => 10,
						),
					),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'            => array( 'type' => 'boolean' ),
						'total_matches' => array( 'type' => 'integer' ),
						'truncated'     => array( 'type' => 'boolean' ),
						'matches'       => array( 'type' => 'array' ),
						'error'         => array( 'type' => 'string' ),
					),
					'required'   => array( 'ok', 'total_matches', 'truncated', 'matches' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return Post_Query::find_posts( $input );
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
			'sitepilot/get-post',
			array(
				'label'               => __( 'Get post', 'sitepilot' ),
				'description'         => __( 'Returns a single post, including its raw stored content, by id or a unique lookup.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_id'   => array( 'type' => 'integer', 'minimum' => 1 ),
						'post_type' => array( 'type' => 'string', 'default' => 'any' ),
						'status'    => array( 'type' => 'string', 'default' => 'any' ),
						'slug'      => array( 'type' => 'string' ),
						'title'     => array( 'type' => 'string' ),
						'search'    => array( 'type' => 'string' ),
						'category'  => array( 'type' => 'string' ),
					),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'             => array( 'type' => 'boolean' ),
						'post_id'        => array( 'type' => 'integer' ),
						'post_type'      => array( 'type' => 'string' ),
						'post_status'    => array( 'type' => 'string' ),
						'post_title'     => array( 'type' => 'string' ),
						'post_name'      => array( 'type' => 'string' ),
						'post_excerpt'   => array( 'type' => 'string' ),
						'post_content'   => array( 'type' => 'string' ),
						'post_date_gmt'  => array( 'type' => 'string' ),
						'modified_gmt'   => array( 'type' => 'string' ),
						'permalink'      => array( 'type' => 'string' ),
						'category_slugs' => array( 'type' => 'array' ),
						'error'          => array( 'type' => 'string' ),
						'total_matches'  => array( 'type' => 'integer' ),
						'matches'        => array( 'type' => 'array' ),
					),
					'required'   => array( 'ok' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return Post_Query::get_post( $input );
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
