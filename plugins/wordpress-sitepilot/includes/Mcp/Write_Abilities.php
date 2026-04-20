<?php
/**
 * SitePilot MCP write abilities: draft posts, field updates, SEO meta (T28).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

use SitePilot\Registration\Store;
use SitePilot\Security\Signed_Request_Verifier;

/**
 * Registers vetted write tools with dry-run support for the desktop orchestrator.
 */
final class Write_Abilities {

	public static function register_hooks(): void {
		add_action( 'wp_abilities_api_init', array( self::class, 'register_abilities' ), 8 );
	}

	public static function register_abilities(): void {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}

		wp_register_ability(
			'sitepilot/create-draft-post',
			array(
				'label'               => __( 'Create draft post', 'sitepilot' ),
				'description'         => __( 'Creates a draft post of a registered post type (or previews creation when dry_run is true). For block editor content, prefer a parsed block tree in blocks so WordPress core can serialize it; content remains available for pre-serialized HTML.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_type' => array(
							'type'    => 'string',
							'default' => 'post',
						),
						'title'     => array( 'type' => 'string', 'minLength' => 1 ),
						'content'   => array( 'type' => 'string' ),
						'blocks'    => array( 'type' => 'array' ),
						'dry_run'   => array( 'type' => 'boolean', 'default' => false ),
					),
					'required'             => array( 'title' ),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'                    => array( 'type' => 'boolean' ),
						'dry_run'               => array( 'type' => 'boolean' ),
						'post_id'               => array( 'type' => 'integer' ),
						'post_type'             => array( 'type' => 'string' ),
						'post_status'           => array( 'type' => 'string' ),
						'preview'               => array( 'type' => 'object' ),
						'error'                 => array( 'type' => 'string' ),
						'reversible'            => array( 'type' => 'boolean' ),
						'compensation_required' => array( 'type' => 'boolean' ),
					),
					'required'   => array( 'ok', 'dry_run', 'post_type', 'post_status' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return self::exec_create_draft_post( $input );
				},
				'permission_callback' => static function ( $input = array() ) {
					unset( $input );
					return self::trusted_or_can_edit_posts();
				},
				'meta'                => array(
					'annotations' => array(
						'readonly'    => false,
						'destructive' => false,
						'idempotent'  => false,
					),
				),
			)
		);

		wp_register_ability(
			'sitepilot/update-post-fields',
			array(
				'label'               => __( 'Update post fields', 'sitepilot' ),
				'description'         => __( 'Updates title, content, or excerpt on an existing post (preview when dry_run is true). For block editor content, prefer a parsed block tree in blocks so WordPress core can serialize it; content remains available for pre-serialized HTML.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_id'   => array( 'type' => 'integer', 'minimum' => 1 ),
						'title'     => array( 'type' => 'string' ),
						'content'   => array( 'type' => 'string' ),
						'blocks'    => array( 'type' => 'array' ),
						'excerpt'   => array( 'type' => 'string' ),
						'dry_run'   => array( 'type' => 'boolean', 'default' => false ),
					),
					'required'             => array( 'post_id' ),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'      => array( 'type' => 'boolean' ),
						'dry_run' => array( 'type' => 'boolean' ),
						'post_id' => array( 'type' => 'integer' ),
						'before'  => array( 'type' => 'object' ),
						'after'   => array( 'type' => 'object' ),
						'error'   => array( 'type' => 'string' ),
					),
					'required'   => array( 'ok', 'dry_run', 'post_id' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return self::exec_update_post_fields( $input );
				},
				'permission_callback' => static function ( $input = array() ) {
					unset( $input );
					return self::trusted_or_can_edit_posts();
				},
				'meta'                => array(
					'annotations' => array(
						'readonly'    => false,
						'destructive' => false,
						'idempotent'  => false,
					),
				),
			)
		);

		wp_register_ability(
			'sitepilot/set-post-seo-meta',
			array(
				'label'               => __( 'Set post SEO meta', 'sitepilot' ),
				'description'         => __( 'Stores SitePilot SEO title and description in post meta (_sitepilot_seo_*). Respects dry_run previews.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_id'          => array( 'type' => 'integer', 'minimum' => 1 ),
						'seo_title'        => array( 'type' => 'string', 'maxLength' => 200 ),
						'seo_description'  => array( 'type' => 'string', 'maxLength' => 320 ),
						'dry_run'          => array( 'type' => 'boolean', 'default' => false ),
					),
					'required'             => array( 'post_id' ),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'      => array( 'type' => 'boolean' ),
						'dry_run' => array( 'type' => 'boolean' ),
						'post_id' => array( 'type' => 'integer' ),
						'before'  => array( 'type' => 'object' ),
						'after'   => array( 'type' => 'object' ),
						'error'   => array( 'type' => 'string' ),
					),
					'required'   => array( 'ok', 'dry_run', 'post_id' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return self::exec_set_post_seo_meta( $input );
				},
				'permission_callback' => static function ( $input = array() ) {
					unset( $input );
					return self::trusted_or_can_edit_posts();
				},
				'meta'                => array(
					'annotations' => array(
						'readonly'    => false,
						'destructive' => false,
						'idempotent'  => false,
					),
				),
			)
		);
	}

	private static function trusted_or_can_edit_posts(): bool {
		if ( current_user_can( 'edit_posts' ) ) {
			return true;
		}
		$sid = Signed_Request_Verifier::get_authenticated_site_id();
		return $sid !== '' && Store::get_site( $sid ) !== null;
	}

	private static function trusted_or_can_edit_post( int $post_id ): bool {
		if ( current_user_can( 'edit_post', $post_id ) ) {
			return true;
		}
		$sid = Signed_Request_Verifier::get_authenticated_site_id();
		if ( $sid === '' || Store::get_site( $sid ) === null ) {
			return false;
		}
		$post = get_post( $post_id );
		return $post instanceof \WP_Post;
	}

	/**
	 * @param mixed $value Candidate block node.
	 * @return array<string, mixed>|null
	 */
	private static function sanitize_parsed_block( $value ): ?array {
		if ( ! is_array( $value ) ) {
			return null;
		}

		$block_name = isset( $value['blockName'] ) ? sanitize_text_field( (string) $value['blockName'] ) : '';
		if ( '' === $block_name ) {
			return null;
		}

		$attrs = array();
		if ( isset( $value['attrs'] ) && is_array( $value['attrs'] ) ) {
			$attrs = $value['attrs'];
		}

		$inner_blocks = array();
		if ( isset( $value['innerBlocks'] ) && is_array( $value['innerBlocks'] ) ) {
			foreach ( $value['innerBlocks'] as $inner_block ) {
				$sanitized_inner = self::sanitize_parsed_block( $inner_block );
				if ( null !== $sanitized_inner ) {
					$inner_blocks[] = $sanitized_inner;
				}
			}
		}

		$inner_html = isset( $value['innerHTML'] ) ? wp_kses_post( (string) $value['innerHTML'] ) : '';

		$inner_content = array();
		if ( isset( $value['innerContent'] ) && is_array( $value['innerContent'] ) ) {
			foreach ( $value['innerContent'] as $chunk ) {
				if ( is_string( $chunk ) ) {
					$inner_content[] = wp_kses_post( $chunk );
				} else {
					$inner_content[] = null;
				}
			}
		}

		return array(
			'blockName'    => $block_name,
			'attrs'        => $attrs,
			'innerBlocks'  => $inner_blocks,
			'innerHTML'    => $inner_html,
			'innerContent' => $inner_content,
		);
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return string
	 */
	private static function resolve_post_content_input( array $input ): string {
		if ( isset( $input['blocks'] ) && is_array( $input['blocks'] ) ) {
			$blocks = array();
			foreach ( $input['blocks'] as $block ) {
				$sanitized = self::sanitize_parsed_block( $block );
				if ( null !== $sanitized ) {
					$blocks[] = $sanitized;
				}
			}

			if ( ! empty( $blocks ) ) {
				return serialize_blocks( $blocks );
			}
		}

		return isset( $input['content'] ) ? wp_kses_post( (string) $input['content'] ) : '';
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function exec_create_draft_post( array $input ): array {
		$dry_run = ! empty( $input['dry_run'] );
		$title   = sanitize_text_field( (string) $input['title'] );
		$ptype   = isset( $input['post_type'] ) ? sanitize_key( (string) $input['post_type'] ) : 'post';
		$content = self::resolve_post_content_input( $input );

		if ( $title === '' ) {
			return array(
				'ok'          => false,
				'dry_run'     => $dry_run,
				'post_id'     => 0,
				'post_type'   => $ptype,
				'post_status' => 'draft',
				'error'       => 'title_required',
			);
		}

		if ( ! post_type_exists( $ptype ) ) {
			return array(
				'ok'          => false,
				'dry_run'     => $dry_run,
				'post_id'     => 0,
				'post_type'   => $ptype,
				'post_status' => 'draft',
				'error'       => 'invalid_post_type',
			);
		}

		$pto = get_post_type_object( $ptype );
		if ( ! $pto instanceof \WP_Post_Type ) {
			return array(
				'ok'          => false,
				'dry_run'     => $dry_run,
				'post_id'     => 0,
				'post_type'   => $ptype,
				'post_status' => 'draft',
				'error'       => 'post_type_unavailable',
			);
		}

		$sid     = Signed_Request_Verifier::get_authenticated_site_id();
		$trusted = $sid !== '' && Store::get_site( $sid ) !== null;
		if ( ! $trusted && ! current_user_can( $pto->cap->create_posts ) ) {
			return array(
				'ok'          => false,
				'dry_run'     => $dry_run,
				'post_id'     => 0,
				'post_type'   => $ptype,
				'post_status' => 'draft',
				'error'       => 'insufficient_capability',
			);
		}

		if ( $dry_run ) {
			return array(
				'ok'                    => true,
				'dry_run'               => true,
				'post_id'               => 0,
				'post_type'             => $ptype,
				'post_status'           => 'draft',
				'reversible'            => true,
				'compensation_required' => false,
				'preview'               => array(
					'post_title'   => $title,
					'post_content' => $content,
					'post_status'  => 'draft',
				),
			);
		}

		$post_id = wp_insert_post(
			array(
				'post_type'    => $ptype,
				'post_title'   => $title,
				'post_content' => $content,
				'post_status'  => 'draft',
			),
			true
		);

		if ( is_wp_error( $post_id ) ) {
			return array(
				'ok'          => false,
				'dry_run'     => false,
				'post_id'     => 0,
				'post_type'   => $ptype,
				'post_status' => 'draft',
				'error'       => $post_id->get_error_message(),
			);
		}

		return array(
			'ok'                    => true,
			'dry_run'               => false,
			'post_id'               => (int) $post_id,
			'post_type'             => $ptype,
			'post_status'           => 'draft',
			'reversible'            => false,
			'compensation_required' => true,
		);
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function exec_update_post_fields( array $input ): array {
		$dry_run = ! empty( $input['dry_run'] );
		$post_id = absint( $input['post_id'] );
		if ( $post_id < 1 ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => 0,
				'error'   => 'invalid_post_id',
			);
		}

		$post = get_post( $post_id );
		if ( ! $post instanceof \WP_Post ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => $post_id,
				'error'   => 'post_not_found',
			);
		}

		if ( ! self::trusted_or_can_edit_post( $post_id ) ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => $post_id,
				'error'   => 'insufficient_capability',
			);
		}

		$before = array(
			'post_title'   => $post->post_title,
			'post_content' => $post->post_content,
			'post_excerpt' => $post->post_excerpt,
		);

		$after = $before;
		if ( array_key_exists( 'title', $input ) ) {
			$after['post_title'] = sanitize_text_field( (string) $input['title'] );
		}
		if ( array_key_exists( 'content', $input ) || array_key_exists( 'blocks', $input ) ) {
			$after['post_content'] = self::resolve_post_content_input( $input );
		}
		if ( array_key_exists( 'excerpt', $input ) ) {
			$after['post_excerpt'] = sanitize_textarea_field( (string) $input['excerpt'] );
		}

		if ( $dry_run ) {
			return array(
				'ok'      => true,
				'dry_run' => true,
				'post_id' => $post_id,
				'before'  => $before,
				'after'   => $after,
			);
		}

		$update = array( 'ID' => $post_id );
		if ( array_key_exists( 'title', $input ) ) {
			$update['post_title'] = $after['post_title'];
		}
		if ( array_key_exists( 'content', $input ) || array_key_exists( 'blocks', $input ) ) {
			$update['post_content'] = $after['post_content'];
		}
		if ( array_key_exists( 'excerpt', $input ) ) {
			$update['post_excerpt'] = $after['post_excerpt'];
		}

		$result = wp_update_post( $update, true );
		if ( is_wp_error( $result ) ) {
			return array(
				'ok'      => false,
				'dry_run' => false,
				'post_id' => $post_id,
				'error'   => $result->get_error_message(),
			);
		}

		return array(
			'ok'      => true,
			'dry_run' => false,
			'post_id' => $post_id,
			'before'  => $before,
			'after'   => array(
				'post_title'   => get_post_field( 'post_title', $post_id ),
				'post_content' => get_post_field( 'post_content', $post_id ),
				'post_excerpt' => get_post_field( 'post_excerpt', $post_id ),
			),
		);
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function exec_set_post_seo_meta( array $input ): array {
		$dry_run = ! empty( $input['dry_run'] );
		$post_id = absint( $input['post_id'] );
		if ( $post_id < 1 ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => 0,
				'error'   => 'invalid_post_id',
			);
		}

		$post = get_post( $post_id );
		if ( ! $post instanceof \WP_Post ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => $post_id,
				'error'   => 'post_not_found',
			);
		}

		if ( ! self::trusted_or_can_edit_post( $post_id ) ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => $post_id,
				'error'   => 'insufficient_capability',
			);
		}

		$key_title = '_sitepilot_seo_title';
		$key_desc  = '_sitepilot_seo_description';

		$before = array(
			$key_title => (string) get_post_meta( $post_id, $key_title, true ),
			$key_desc  => (string) get_post_meta( $post_id, $key_desc, true ),
		);

		$next_title = $before[ $key_title ];
		$next_desc  = $before[ $key_desc ];
		if ( array_key_exists( 'seo_title', $input ) ) {
			$next_title = sanitize_text_field( (string) $input['seo_title'] );
		}
		if ( array_key_exists( 'seo_description', $input ) ) {
			$next_desc = sanitize_textarea_field( (string) $input['seo_description'] );
		}

		$after = array(
			$key_title => $next_title,
			$key_desc  => $next_desc,
		);

		if ( $dry_run ) {
			return array(
				'ok'      => true,
				'dry_run' => true,
				'post_id' => $post_id,
				'before'  => $before,
				'after'   => $after,
			);
		}

		if ( array_key_exists( 'seo_title', $input ) ) {
			update_post_meta( $post_id, $key_title, $next_title );
		}
		if ( array_key_exists( 'seo_description', $input ) ) {
			update_post_meta( $post_id, $key_desc, $next_desc );
		}

		return array(
			'ok'      => true,
			'dry_run' => false,
			'post_id' => $post_id,
			'before'  => $before,
			'after'   => array(
				$key_title => (string) get_post_meta( $post_id, $key_title, true ),
				$key_desc  => (string) get_post_meta( $post_id, $key_desc, true ),
			),
		);
	}
}
