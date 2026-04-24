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
						'blocks'    => self::parsed_blocks_schema(),
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
						'after'                 => array( 'type' => 'object' ),
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
						'blocks'    => self::parsed_blocks_schema(),
						'replace_content' => array( 'type' => 'boolean', 'default' => false ),
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
						'meta_provider' => array( 'type' => 'string' ),
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
				'description'         => __( 'Stores SEO title and description in SitePilot or provider-specific post meta fields, with dry_run previews.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_id'          => array( 'type' => 'integer', 'minimum' => 1 ),
						'seo_title'        => array( 'type' => 'string', 'maxLength' => 200 ),
						'seo_description'  => array( 'type' => 'string', 'maxLength' => 320 ),
						'meta_provider'    => array( 'type' => 'string', 'enum' => array( 'sitepilot', 'yoast' ) ),
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

		wp_register_ability(
			'sitepilot/set-post-featured-image',
			array(
				'label'               => __( 'Set post featured image', 'sitepilot' ),
				'description'         => __( 'Sets the featured image on a post using an attachment id, with dry_run previews.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'post_id'            => array( 'type' => 'integer', 'minimum' => 1 ),
						'attachment_id'      => array( 'type' => 'integer', 'minimum' => 1 ),
						'featured_image_url' => array( 'type' => 'string' ),
						'dry_run'            => array( 'type' => 'boolean', 'default' => false ),
					),
					'required'             => array( 'post_id' ),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'            => array( 'type' => 'boolean' ),
						'dry_run'       => array( 'type' => 'boolean' ),
						'post_id'       => array( 'type' => 'integer' ),
						'attachment_id' => array( 'type' => 'integer' ),
						'before'        => array( 'type' => 'object' ),
						'after'         => array( 'type' => 'object' ),
						'error'         => array( 'type' => 'string' ),
					),
					'required'   => array( 'ok', 'dry_run', 'post_id' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return self::exec_set_post_featured_image( $input );
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
			'sitepilot/upload-media-asset',
			array(
				'label'               => __( 'Upload media asset', 'sitepilot' ),
				'description'         => __( 'Uploads a base64-encoded image into the Media Library and returns its attachment id and URL. Respects dry_run previews.', 'sitepilot' ),
				'category'            => 'sitepilot',
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'file_name'   => array( 'type' => 'string', 'minLength' => 1 ),
						'media_type'  => array( 'type' => 'string', 'minLength' => 1 ),
						'data_base64' => array( 'type' => 'string', 'minLength' => 1 ),
						'alt_text'    => array( 'type' => 'string' ),
						'dry_run'     => array( 'type' => 'boolean', 'default' => false ),
					),
					'required'             => array( 'file_name', 'media_type', 'data_base64' ),
					'additionalProperties' => false,
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'ok'            => array( 'type' => 'boolean' ),
						'dry_run'       => array( 'type' => 'boolean' ),
						'attachment_id' => array( 'type' => 'integer' ),
						'url'           => array( 'type' => 'string' ),
						'file_name'     => array( 'type' => 'string' ),
						'media_type'    => array( 'type' => 'string' ),
						'bytes'         => array( 'type' => 'integer' ),
						'preview'       => array( 'type' => 'object' ),
						'error'         => array( 'type' => 'string' ),
					),
					'required'   => array( 'ok', 'dry_run', 'file_name', 'media_type' ),
				),
				'execute_callback'    => static function ( array $input ) {
					return self::exec_upload_media_asset( $input );
				},
				'permission_callback' => static function ( $input = array() ) {
					unset( $input );
					return self::trusted_or_can_upload_files();
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

	/**
	 * Returns a permissive JSON schema for parsed Gutenberg blocks.
	 *
	 * The schema stays shallow on recursive nodes to remain compatible with the
	 * REST validator while still typing block attrs as values rather than schemas.
	 *
	 * @return array<string, mixed>
	 */
	private static function parsed_blocks_schema(): array {
		return array(
			'type'  => 'array',
			'items' => self::parsed_block_schema(),
		);
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function parsed_block_schema(): array {
		return array(
			'type'                 => 'object',
			'properties'           => array(
				'blockName'    => array( 'type' => 'string' ),
				'attrs'        => array(
					'type'                 => 'object',
					'additionalProperties' => self::json_value_schema(),
					'default'              => array(),
				),
				'innerBlocks'  => array(
					'type'  => 'array',
					'items' => array( 'type' => 'object' ),
				),
				'innerHTML'    => array( 'type' => 'string' ),
				'innerContent' => array(
					'type'  => 'array',
					'items' => array(
						'type' => array( 'string', 'null' ),
					),
				),
			),
			'required'             => array( 'blockName', 'attrs', 'innerBlocks', 'innerHTML', 'innerContent' ),
			'additionalProperties' => false,
		);
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function json_value_schema(): array {
		return array(
			'type' => array( 'string', 'number', 'integer', 'boolean', 'array', 'object', 'null' ),
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

	private static function trusted_or_can_upload_files(): bool {
		if ( current_user_can( 'upload_files' ) ) {
			return true;
		}
		$sid = Signed_Request_Verifier::get_authenticated_site_id();
		return $sid !== '' && Store::get_site( $sid ) !== null;
	}

	/**
	 * @param mixed $value Candidate block node.
	 * @param string $path Path used in validation messages.
	 * @return array<string, mixed>
	 */
	private static function sanitize_parsed_block( $value, string $path ) {
		if ( ! is_array( $value ) ) {
			return self::invalid_blocks( $path . ' must be an object' );
		}

		if ( ! array_key_exists( 'blockName', $value ) || ! is_string( $value['blockName'] ) ) {
			return self::invalid_blocks( $path . '.blockName must be a string' );
		}

		if ( ! array_key_exists( 'attrs', $value ) || ! is_array( $value['attrs'] ) ) {
			return self::invalid_blocks( $path . '.attrs must be an object' );
		}

		if ( ! array_key_exists( 'innerBlocks', $value ) || ! is_array( $value['innerBlocks'] ) ) {
			return self::invalid_blocks( $path . '.innerBlocks must be an array' );
		}

		if ( ! array_key_exists( 'innerHTML', $value ) || ! is_string( $value['innerHTML'] ) ) {
			return self::invalid_blocks( $path . '.innerHTML must be a string' );
		}

		if ( ! array_key_exists( 'innerContent', $value ) || ! is_array( $value['innerContent'] ) ) {
			return self::invalid_blocks( $path . '.innerContent must be an array' );
		}

		$block_name = self::normalize_block_name( $value['blockName'] );
		if ( '' === $block_name ) {
			return self::invalid_blocks( $path . '.blockName must not be empty' );
		}
		if ( ! self::is_supported_executable_block( $block_name ) ) {
			return self::invalid_blocks(
				$path . ' uses unsupported block "' . $block_name . '". ' . self::unsupported_block_reason( $block_name )
			);
		}

		$attrs = self::sanitize_block_attrs( $value['attrs'] );
		if ( ! is_array( $attrs ) ) {
			$attrs = array();
		}

		$url_error = self::validate_media_urls( $block_name, $attrs, $path . '.attrs' );
		if ( null !== $url_error ) {
			return self::invalid_blocks( $url_error );
		}

		$inner_blocks = array();
		foreach ( $value['innerBlocks'] as $index => $inner_block ) {
			$sanitized_inner = self::sanitize_parsed_block( $inner_block, $path . '.innerBlocks[' . $index . ']' );
			if ( ! $sanitized_inner['ok'] ) {
				return $sanitized_inner;
			}
			$inner_blocks[] = $sanitized_inner['block'];
		}

		$inner_content = array();
		foreach ( $value['innerContent'] as $index => $chunk ) {
			if ( is_string( $chunk ) ) {
				$inner_content[] = wp_kses_post( self::normalize_text_chunk( $chunk, $block_name, $attrs ) );
				continue;
			}
			if ( null === $chunk ) {
				$inner_content[] = null;
				continue;
			}
			return self::invalid_blocks( $path . '.innerContent[' . $index . '] must be a string or null' );
		}

		$inner_html = wp_kses_post( $value['innerHTML'] );
		if ( 'core/paragraph' === $block_name || 'core/heading' === $block_name ) {
			$inner_html    = wp_kses_post( self::normalize_text_chunk( $inner_html, $block_name, $attrs ) );
			$inner_content = array( $inner_html );
		}

		if ( 'core/image' === $block_name ) {
			$image_html = self::image_html( $attrs );
			if ( '' !== $image_html ) {
				$inner_html    = $image_html;
				$inner_content = array( $image_html );
			} elseif ( '' !== $inner_html && empty( $inner_content ) ) {
				$inner_content = array( $inner_html );
			}
		}

		if ( 'core/spacer' === $block_name ) {
			$spacer       = self::spacer_html( $attrs );
			$attrs        = $spacer['attrs'];
			$inner_html   = $spacer['html'];
			$inner_content = array( $inner_html );
		}

		if ( 'core/code' === $block_name ) {
			$inner_html    = self::code_html( $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/preformatted' === $block_name ) {
			$inner_html    = self::preformatted_html( $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/quote' === $block_name ) {
			$inner_html    = self::quote_html( $attrs, $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/button' === $block_name ) {
			$inner_html    = self::button_html( $attrs, $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/more' === $block_name ) {
			$inner_html    = self::more_html( $attrs );
			$inner_content = array( $inner_html );
		}

		if ( 'core/html' === $block_name ) {
			$inner_html    = self::raw_block_html( $attrs, 'content', $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/shortcode' === $block_name ) {
			$inner_html    = self::raw_block_html( $attrs, 'text', $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/file' === $block_name ) {
			$inner_html    = self::file_html( $attrs );
			$inner_content = '' !== $inner_html ? array( $inner_html ) : array();
		}

		if ( 'core/pullquote' === $block_name ) {
			$inner_html    = self::pullquote_html( $attrs, $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/separator' === $block_name ) {
			$inner_html    = self::separator_html( $attrs );
			$inner_content = array( $inner_html );
		}

		if ( 'core/table' === $block_name ) {
			$inner_html    = self::table_html( $attrs );
			$inner_content = '' !== $inner_html ? array( $inner_html ) : array();
		}

		if ( 'core/video' === $block_name ) {
			$inner_html    = self::video_html( $attrs );
			$inner_content = array( $inner_html );
		}

		if ( 'core/list-item' === $block_name ) {
			$inner_html    = self::list_item_html( $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/verse' === $block_name ) {
			$inner_html    = self::verse_html( $inner_html );
			$inner_content = array( $inner_html );
		}

		if ( 'core/read-more' === $block_name ) {
			$inner_html    = '';
			$inner_content = array();
		}

		$container_inner_content = self::canonical_container_inner_content( $block_name, $attrs, $inner_blocks );
		if ( null !== $container_inner_content ) {
			$inner_content = $container_inner_content;
			$inner_html    = implode(
				'',
				array_filter(
					$inner_content,
					static fn ( $chunk ) => null !== $chunk
				)
			);
		}

		return array(
			'ok'    => true,
			'block' => array(
				'blockName'    => $block_name,
				'attrs'        => $attrs,
				'innerBlocks'  => $inner_blocks,
				'innerHTML'    => $inner_html,
				'innerContent' => $inner_content,
			),
		);
	}

	private static function normalize_block_name( string $raw ): string {
		$name = trim( $raw );
		if ( str_starts_with( $name, 'wp:' ) ) {
			$name = substr( $name, 3 );
			$name = str_contains( $name, '/' ) ? $name : 'core/' . $name;
		} elseif ( str_starts_with( $name, 'core:' ) ) {
			$name = 'core/' . substr( $name, 5 );
		}

		$core_block_names = array_map(
			static fn ( string $block_name ): string => str_replace( 'core/', '', $block_name ),
			self::wordpress_core_block_names()
		);
		if ( ! str_contains( $name, '/' ) && in_array( $name, $core_block_names, true ) ) {
			$name = 'core/' . $name;
		}

		return sanitize_text_field( $name );
	}

	private static function normalize_text_chunk( string $chunk, string $block_name, array $attrs = array() ): string {
		if ( preg_match( '/<[a-z][\s\S]*>/i', $chunk ) ) {
			if ( 'core/heading' === $block_name ) {
				return self::normalize_heading_html( $chunk, $attrs );
			}
			return $chunk;
		}

		$text = htmlspecialchars( $chunk, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		if ( 'core/paragraph' === $block_name ) {
			return '<p>' . $text . '</p>';
		}
		if ( 'core/heading' === $block_name ) {
			$tag = self::heading_tag_name( $attrs );
			return '<' . $tag . '>' . $text . '</' . $tag . '>';
		}

		return $text;
	}

	private static function extract_text_content( string $html ): string {
		$text = preg_replace( '/<br\s*\/?>/i', "\n", $html );
		$text = is_string( $text ) ? $text : $html;
		$text = preg_replace( '/<\/p>\s*<p>/i', "\n\n", $text );
		$text = is_string( $text ) ? $text : $html;
		$text = strip_tags( $text );
		return trim( $text );
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function quote_html( array $attrs, string $inner_html ): string {
		$classes    = array( 'wp-block-quote' );
		$text_align = isset( $attrs['textAlign'] ) && is_string( $attrs['textAlign'] ) ? trim( $attrs['textAlign'] ) : '';
		if ( '' !== $text_align ) {
			$classes[] = 'has-text-align-' . htmlspecialchars( $text_align, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		if ( preg_match( '/<blockquote\b/i', $inner_html ) ) {
			$normalized = preg_replace(
				'/<blockquote\b[^>]*>/i',
				'<blockquote class="' . implode( ' ', $classes ) . '">',
				trim( $inner_html ),
				1
			);
			return is_string( $normalized ) ? $normalized : trim( $inner_html );
		}
		$text     = htmlspecialchars( self::extract_text_content( $inner_html ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		$citation = isset( $attrs['citation'] ) && is_string( $attrs['citation'] ) ? trim( $attrs['citation'] ) : '';
		$cite     = '' !== $citation ? '<cite>' . htmlspecialchars( $citation, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '</cite>' : '';
		return '<blockquote class="' . implode( ' ', $classes ) . '"><p>' . $text . '</p>' . $cite . '</blockquote>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function pullquote_html( array $attrs, string $inner_html ): string {
		$classes    = array( 'wp-block-pullquote' );
		$text_align = isset( $attrs['textAlign'] ) && is_string( $attrs['textAlign'] ) ? trim( $attrs['textAlign'] ) : '';
		if ( '' !== $text_align ) {
			$classes[] = 'has-text-align-' . htmlspecialchars( $text_align, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		$value = isset( $attrs['value'] ) && is_string( $attrs['value'] ) && '' !== trim( $attrs['value'] )
			? $attrs['value']
			: self::extract_text_content( $inner_html );
		$citation = isset( $attrs['citation'] ) && is_string( $attrs['citation'] ) ? trim( $attrs['citation'] ) : '';
		$cite = '' !== $citation ? '<cite>' . htmlspecialchars( $citation, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '</cite>' : '';
		return '<figure class="' . implode( ' ', $classes ) . '"><blockquote><p>' . htmlspecialchars( $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '</p>' . $cite . '</blockquote></figure>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function raw_block_html( array $attrs, string $attr_name, string $fallback ): string {
		if ( preg_match( '/<[a-z][\s\S]*>/i', $fallback ) ) {
			return $fallback;
		}
		return isset( $attrs[ $attr_name ] ) && is_string( $attrs[ $attr_name ] ) ? $attrs[ $attr_name ] : $fallback;
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function more_html( array $attrs ): string {
		$custom_text = isset( $attrs['customText'] ) && is_string( $attrs['customText'] ) ? trim( $attrs['customText'] ) : '';
		$more_tag = '' !== $custom_text ? '<!--more ' . $custom_text . '-->' : '<!--more-->';
		$no_teaser = isset( $attrs['noTeaser'] ) && true === $attrs['noTeaser'] ? '<!--noteaser-->' : '';
		return implode( "\n", array_filter( array( $more_tag, $no_teaser ) ) );
	}

	private static function code_html( string $inner_html ): string {
		$text = htmlspecialchars( self::extract_text_content( $inner_html ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		return '<pre class="wp-block-code"><code>' . $text . '</code></pre>';
	}

	private static function preformatted_html( string $inner_html ): string {
		$text = htmlspecialchars( self::extract_text_content( $inner_html ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		return '<pre class="wp-block-preformatted">' . $text . '</pre>';
	}

	private static function verse_html( string $inner_html ): string {
		$text = htmlspecialchars( self::extract_text_content( $inner_html ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		return '<pre class="wp-block-verse">' . $text . '</pre>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function separator_html( array $attrs ): string {
		$tag_name = isset( $attrs['tagName'] ) && is_string( $attrs['tagName'] ) && '' !== trim( $attrs['tagName'] )
			? trim( $attrs['tagName'] )
			: 'hr';
		$classes  = array( 'wp-block-separator' );
		$opacity  = isset( $attrs['opacity'] ) && is_string( $attrs['opacity'] ) ? trim( $attrs['opacity'] ) : 'alpha-channel';
		if ( 'css' === $opacity ) {
			$classes[] = 'has-css-opacity';
		} else {
			$classes[] = 'has-alpha-channel-opacity';
		}
		return '<' . $tag_name . ' class="' . implode( ' ', $classes ) . '"/>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function button_html( array $attrs, string $inner_html ): string {
		$tag_name = ( isset( $attrs['tagName'] ) && 'button' === $attrs['tagName'] ) ? 'button' : 'a';
		$text_source = isset( $attrs['text'] ) && is_string( $attrs['text'] ) && '' !== trim( $attrs['text'] )
			? $attrs['text']
			: self::extract_text_content( $inner_html );
		$text = htmlspecialchars( $text_source, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		$title = isset( $attrs['title'] ) && is_string( $attrs['title'] ) && '' !== trim( $attrs['title'] )
			? ' title="' . htmlspecialchars( $attrs['title'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"'
			: '';
		$target = 'a' === $tag_name && isset( $attrs['linkTarget'] ) && is_string( $attrs['linkTarget'] ) && '' !== trim( $attrs['linkTarget'] )
			? ' target="' . htmlspecialchars( $attrs['linkTarget'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"'
			: '';
		$rel = 'a' === $tag_name && isset( $attrs['rel'] ) && is_string( $attrs['rel'] ) && '' !== trim( $attrs['rel'] )
			? ' rel="' . htmlspecialchars( $attrs['rel'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"'
			: '';
		$href = 'a' === $tag_name && isset( $attrs['url'] ) && is_string( $attrs['url'] ) && '' !== trim( $attrs['url'] )
			? ' href="' . htmlspecialchars( $attrs['url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"'
			: '';
		$type = 'button' === $tag_name && isset( $attrs['type'] ) && is_string( $attrs['type'] ) && '' !== trim( $attrs['type'] )
			? ' type="' . htmlspecialchars( $attrs['type'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"'
			: ( 'button' === $tag_name ? ' type="button"' : '' );

		return '<div class="wp-block-button"><' . $tag_name . ' class="wp-block-button__link wp-element-button"' . $href . $title . $target . $rel . $type . '>' . $text . '</' . $tag_name . '></div>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function file_html( array $attrs ): string {
		$href = isset( $attrs['href'] ) && is_string( $attrs['href'] ) ? trim( $attrs['href'] ) : '';
		if ( '' === $href ) {
			return '';
		}
		$file_name = isset( $attrs['fileName'] ) && is_string( $attrs['fileName'] ) ? $attrs['fileName'] : '';
		$text_link_href = isset( $attrs['textLinkHref'] ) && is_string( $attrs['textLinkHref'] ) && '' !== trim( $attrs['textLinkHref'] ) ? trim( $attrs['textLinkHref'] ) : $href;
		$text_link_target = isset( $attrs['textLinkTarget'] ) && is_string( $attrs['textLinkTarget'] ) && '' !== trim( $attrs['textLinkTarget'] ) ? ' target="' . htmlspecialchars( trim( $attrs['textLinkTarget'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '';
		$link_rel = '' !== $text_link_target ? ' rel="noreferrer noopener"' : '';
		$file_id = isset( $attrs['fileId'] ) && is_string( $attrs['fileId'] ) && '' !== trim( $attrs['fileId'] ) ? trim( $attrs['fileId'] ) : '';
		$described_by = '' !== $file_name && '' !== $file_id ? $file_id : '';
		$preview = '';
		if ( isset( $attrs['displayPreview'] ) && true === $attrs['displayPreview'] ) {
			$preview_height = isset( $attrs['previewHeight'] ) && is_numeric( $attrs['previewHeight'] ) ? (string) $attrs['previewHeight'] : '600';
			$preview = '<object class="wp-block-file__embed" data="' . htmlspecialchars( $href, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" type="application/pdf" style="width:100%;height:' . htmlspecialchars( $preview_height, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . 'px" aria-label="' . htmlspecialchars( '' !== $file_name ? $file_name : 'PDF embed', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"></object>';
		}
		$name_link = '' !== $file_name
			? '<a' . ( '' !== $described_by ? ' id="' . htmlspecialchars( $described_by, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '' ) . ' href="' . htmlspecialchars( $text_link_href, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' . $text_link_target . $link_rel . '>' . $file_name . '</a>'
			: '';
		$download_text = isset( $attrs['downloadButtonText'] ) && is_string( $attrs['downloadButtonText'] ) && '' !== $attrs['downloadButtonText'] ? $attrs['downloadButtonText'] : 'Download';
		$download_button = ( ! isset( $attrs['showDownloadButton'] ) || false !== $attrs['showDownloadButton'] )
			? '<a href="' . htmlspecialchars( $href, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" class="wp-block-file__button wp-element-button" download' . ( '' !== $described_by ? ' aria-describedby="' . htmlspecialchars( $described_by, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '' ) . '>' . $download_text . '</a>'
			: '';
		return '<div class="wp-block-file">' . $preview . $name_link . $download_button . '</div>';
	}

	/**
	 * @param array<string, mixed> $cell Table cell attrs.
	 */
	private static function table_cell_html( array $cell, int $cell_index ): string {
		$tag = isset( $cell['tag'] ) && is_string( $cell['tag'] ) && in_array( $cell['tag'], array( 'td', 'th' ), true ) ? $cell['tag'] : 'td';
		$classes = array();
		$align = isset( $cell['align'] ) && is_string( $cell['align'] ) ? trim( $cell['align'] ) : '';
		if ( '' !== $align ) {
			$classes[] = 'has-text-align-' . htmlspecialchars( $align, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		$attrs = array();
		if ( ! empty( $classes ) ) {
			$attrs[] = 'class="' . implode( ' ', $classes ) . '"';
		}
		if ( '' !== $align ) {
			$attrs[] = 'data-align="' . htmlspecialchars( $align, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		if ( 'th' === $tag && isset( $cell['scope'] ) && is_string( $cell['scope'] ) && '' !== trim( $cell['scope'] ) ) {
			$attrs[] = 'scope="' . htmlspecialchars( trim( $cell['scope'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		if ( isset( $cell['colspan'] ) && is_string( $cell['colspan'] ) && '' !== trim( $cell['colspan'] ) ) {
			$attrs[] = 'colspan="' . htmlspecialchars( trim( $cell['colspan'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		if ( isset( $cell['rowspan'] ) && is_string( $cell['rowspan'] ) && '' !== trim( $cell['rowspan'] ) ) {
			$attrs[] = 'rowspan="' . htmlspecialchars( trim( $cell['rowspan'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		$content = isset( $cell['content'] ) && is_string( $cell['content'] ) && '' !== $cell['content']
			? $cell['content']
			: 'Cell ' . (string) ( $cell_index + 1 );
		$attr_string = ! empty( $attrs ) ? ' ' . implode( ' ', $attrs ) : '';
		return '<' . $tag . $attr_string . '>' . $content . '</' . $tag . '>';
	}

	/**
	 * @param string $section_tag Table section tag.
	 * @param mixed $rows_value Table rows.
	 */
	private static function table_section_html( string $section_tag, $rows_value ): string {
		if ( ! is_array( $rows_value ) || empty( $rows_value ) ) {
			return '';
		}
		$rows_html = array();
		foreach ( $rows_value as $row ) {
			if ( ! is_array( $row ) ) {
				continue;
			}
			$cells = isset( $row['cells'] ) && is_array( $row['cells'] ) ? $row['cells'] : array();
			if ( empty( $cells ) ) {
				continue;
			}
			$row_html = '<tr>';
			foreach ( $cells as $cell_index => $cell ) {
				$row_html .= self::table_cell_html( is_array( $cell ) ? $cell : array(), $cell_index );
			}
			$row_html .= '</tr>';
			$rows_html[] = $row_html;
		}
		return ! empty( $rows_html ) ? '<' . $section_tag . '>' . implode( '', $rows_html ) . '</' . $section_tag . '>' : '';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function table_html( array $attrs ): string {
		$head = self::table_section_html( 'thead', $attrs['head'] ?? array() );
		$body = self::table_section_html( 'tbody', $attrs['body'] ?? array() );
		$foot = self::table_section_html( 'tfoot', $attrs['foot'] ?? array() );
		if ( '' === $head && '' === $body && '' === $foot ) {
			return '';
		}
		$table_classes = array();
		if ( ! isset( $attrs['hasFixedLayout'] ) || false !== $attrs['hasFixedLayout'] ) {
			$table_classes[] = 'has-fixed-layout';
		}
		$caption = isset( $attrs['caption'] ) && is_string( $attrs['caption'] ) && '' !== trim( $attrs['caption'] )
			? '<figcaption class="wp-element-caption">' . htmlspecialchars( trim( $attrs['caption'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '</figcaption>'
			: '';
		return '<figure class="wp-block-table"><table' . ( ! empty( $table_classes ) ? ' class="' . implode( ' ', $table_classes ) . '"' : '' ) . '>' . $head . $body . $foot . '</table>' . $caption . '</figure>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function video_tracks_html( array $attrs ): string {
		$tracks = isset( $attrs['tracks'] ) && is_array( $attrs['tracks'] ) ? $attrs['tracks'] : array();
		$html = '';
		foreach ( $tracks as $track ) {
			if ( ! is_array( $track ) ) {
				continue;
			}
			$parts = array();
			foreach ( array( 'kind', 'label', 'src', 'srcLang', 'srclang' ) as $name ) {
				if ( isset( $track[ $name ] ) && is_string( $track[ $name ] ) && '' !== trim( $track[ $name ] ) ) {
					$html_name = 'srcLang' === $name ? 'srclang' : $name;
					$parts[] = $html_name . '="' . htmlspecialchars( trim( $track[ $name ] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
				}
			}
			if ( isset( $track['default'] ) && true === $track['default'] ) {
				$parts[] = 'default';
			}
			$html .= '<track' . ( ! empty( $parts ) ? ' ' . implode( ' ', $parts ) : '' ) . '>';
		}
		return $html;
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function video_html( array $attrs ): string {
		$src = isset( $attrs['src'] ) && is_string( $attrs['src'] ) ? trim( $attrs['src'] ) : '';
		$caption = isset( $attrs['caption'] ) && is_string( $attrs['caption'] ) && '' !== trim( $attrs['caption'] ) ? '<figcaption class="wp-element-caption">' . $attrs['caption'] . '</figcaption>' : '';
		$video_attrs = array();
		if ( isset( $attrs['autoplay'] ) && true === $attrs['autoplay'] ) {
			$video_attrs[] = 'autoplay';
		}
		if ( ! isset( $attrs['controls'] ) || false !== $attrs['controls'] ) {
			$video_attrs[] = 'controls';
		}
		if ( isset( $attrs['loop'] ) && true === $attrs['loop'] ) {
			$video_attrs[] = 'loop';
		}
		if ( isset( $attrs['muted'] ) && true === $attrs['muted'] ) {
			$video_attrs[] = 'muted';
		}
		if ( isset( $attrs['playsInline'] ) && true === $attrs['playsInline'] ) {
			$video_attrs[] = 'playsinline';
		}
		if ( isset( $attrs['poster'] ) && is_string( $attrs['poster'] ) && '' !== trim( $attrs['poster'] ) ) {
			$video_attrs[] = 'poster="' . htmlspecialchars( trim( $attrs['poster'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		if ( isset( $attrs['preload'] ) && is_string( $attrs['preload'] ) && '' !== trim( $attrs['preload'] ) && 'metadata' !== trim( $attrs['preload'] ) ) {
			$video_attrs[] = 'preload="' . htmlspecialchars( trim( $attrs['preload'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		if ( '' !== $src ) {
			$video_attrs[] = 'src="' . htmlspecialchars( $src, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		return '<figure class="wp-block-video">' . ( '' !== $src ? '<video ' . implode( ' ', $video_attrs ) . '>' . self::video_tracks_html( $attrs ) . '</video>' : '' ) . $caption . '</figure>';
	}

	private static function list_item_html( string $inner_html ): string {
		if ( preg_match( '/<li\b/i', $inner_html ) ) {
			$normalized = preg_replace( '/<li\b[^>]*>/i', '<li>', $inner_html, 1 );
			return is_string( $normalized ) ? $normalized : $inner_html;
		}

		$text = htmlspecialchars( self::extract_text_content( $inner_html ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		return '<li>' . $text . '</li>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function heading_tag_name( array $attrs ): string {
		$level = isset( $attrs['level'] ) && is_int( $attrs['level'] ) ? $attrs['level'] : 2;
		if ( $level < 1 || $level > 6 ) {
			$level = 2;
		}
		return 'h' . $level;
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function valid_group_tag_name( array $attrs ): string {
		$tag_name = isset( $attrs['tagName'] ) && is_string( $attrs['tagName'] ) ? trim( $attrs['tagName'] ) : '';
		$allowed = array( 'article', 'aside', 'div', 'footer', 'header', 'main', 'nav', 'section' );
		return in_array( $tag_name, $allowed, true ) ? $tag_name : 'div';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function media_text_media_figure_html( array $attrs ): string {
		$media_type = isset( $attrs['mediaType'] ) && is_string( $attrs['mediaType'] ) ? $attrs['mediaType'] : '';
		$media_url = isset( $attrs['mediaUrl'] ) && is_string( $attrs['mediaUrl'] ) ? trim( $attrs['mediaUrl'] ) : '';
		if ( '' === $media_url || ! in_array( $media_type, array( 'image', 'video' ), true ) ) {
			return '<figure class="wp-block-media-text__media"></figure>';
		}

		if ( 'video' === $media_type ) {
			return '<figure class="wp-block-media-text__media"><video controls src="' . htmlspecialchars( $media_url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"></video></figure>';
		}

		$media_alt = isset( $attrs['mediaAlt'] ) && is_string( $attrs['mediaAlt'] ) ? $attrs['mediaAlt'] : '';
		$media_id = isset( $attrs['mediaId'] ) && is_int( $attrs['mediaId'] ) ? $attrs['mediaId'] : 0;
		$media_size_slug = isset( $attrs['mediaSizeSlug'] ) && is_string( $attrs['mediaSizeSlug'] ) && '' !== trim( $attrs['mediaSizeSlug'] )
			? trim( $attrs['mediaSizeSlug'] )
			: 'full';
		$classes = array();
		if ( $media_id > 0 ) {
			$classes[] = 'wp-image-' . $media_id;
			$classes[] = 'size-' . htmlspecialchars( $media_size_slug, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		$style = '';
		if ( isset( $attrs['imageFill'] ) && true === $attrs['imageFill'] ) {
			$focal_point = isset( $attrs['focalPoint'] ) && is_array( $attrs['focalPoint'] ) ? $attrs['focalPoint'] : array();
			$x = isset( $focal_point['x'] ) && is_numeric( $focal_point['x'] ) ? (float) $focal_point['x'] : 0.5;
			$y = isset( $focal_point['y'] ) && is_numeric( $focal_point['y'] ) ? (float) $focal_point['y'] : 0.5;
			$style = ' style="object-position:' . round( $x * 100 ) . '% ' . round( $y * 100 ) . '%"';
		}
		$img = '<img src="' . htmlspecialchars( $media_url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" alt="' . htmlspecialchars( $media_alt, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' . ( ! empty( $classes ) ? ' class="' . implode( ' ', $classes ) . '"' : '' ) . $style . '/>';
		if ( isset( $attrs['href'] ) && is_string( $attrs['href'] ) && '' !== trim( $attrs['href'] ) ) {
			$link_class = isset( $attrs['linkClass'] ) && is_string( $attrs['linkClass'] ) && '' !== trim( $attrs['linkClass'] ) ? ' class="' . htmlspecialchars( trim( $attrs['linkClass'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '';
			$target = isset( $attrs['linkTarget'] ) && is_string( $attrs['linkTarget'] ) && '' !== trim( $attrs['linkTarget'] ) ? ' target="' . htmlspecialchars( trim( $attrs['linkTarget'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '';
			$rel = isset( $attrs['rel'] ) && is_string( $attrs['rel'] ) && '' !== trim( $attrs['rel'] ) ? ' rel="' . htmlspecialchars( trim( $attrs['rel'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '';
			$img = '<a' . $link_class . ' href="' . htmlspecialchars( trim( $attrs['href'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' . $target . $rel . '>' . $img . '</a>';
		}
		return '<figure class="wp-block-media-text__media">' . $img . '</figure>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function media_text_wrapper_open( array $attrs ): string {
		$classes = array( 'wp-block-media-text' );
		if ( isset( $attrs['mediaPosition'] ) && 'right' === $attrs['mediaPosition'] ) {
			$classes[] = 'has-media-on-the-right';
		}
		if ( isset( $attrs['isStackedOnMobile'] ) && true === $attrs['isStackedOnMobile'] ) {
			$classes[] = 'is-stacked-on-mobile';
		}
		if ( isset( $attrs['verticalAlignment'] ) && is_string( $attrs['verticalAlignment'] ) && '' !== trim( $attrs['verticalAlignment'] ) ) {
			$classes[] = 'is-vertically-aligned-' . htmlspecialchars( trim( $attrs['verticalAlignment'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		if ( isset( $attrs['imageFill'] ) && true === $attrs['imageFill'] ) {
			$classes[] = 'is-image-fill-element';
		}
		$style = '';
		if ( isset( $attrs['mediaWidth'] ) && is_numeric( $attrs['mediaWidth'] ) && 50.0 !== (float) $attrs['mediaWidth'] ) {
			$width = (string) $attrs['mediaWidth'];
			$style = ' style="grid-template-columns:' . ( ( isset( $attrs['mediaPosition'] ) && 'right' === $attrs['mediaPosition'] ) ? 'auto ' . $width . '%' : $width . '% auto' ) . '"';
		}
		return '<div class="' . implode( ' ', $classes ) . '"' . $style . '>';
	}

	/**
	 * @param array<string, mixed> $focal_point Focal point attrs.
	 */
	private static function cover_media_position( array $focal_point ): string {
		$x = isset( $focal_point['x'] ) && is_numeric( $focal_point['x'] ) ? (float) $focal_point['x'] : 0.5;
		$y = isset( $focal_point['y'] ) && is_numeric( $focal_point['y'] ) ? (float) $focal_point['y'] : 0.5;
		return round( $x * 100 ) . '% ' . round( $y * 100 ) . '%';
	}

	private static function cover_dim_ratio_class( $ratio ): string {
		if ( ! is_numeric( $ratio ) || 50.0 === (float) $ratio ) {
			return '';
		}
		return 'has-background-dim-' . (string) ( 10 * round( (float) $ratio / 10 ) );
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function cover_tag_name( array $attrs ): string {
		$tag = isset( $attrs['tagName'] ) && is_string( $attrs['tagName'] ) ? trim( $attrs['tagName'] ) : 'div';
		return '' !== $tag ? $tag : 'div';
	}

	private static function cover_content_position_class( string $position ): string {
		$map = array(
			'top left' => 'is-position-top-left',
			'top center' => 'is-position-top-center',
			'top right' => 'is-position-top-right',
			'center left' => 'is-position-center-left',
			'center center' => 'is-position-center-center',
			'center' => 'is-position-center-center',
			'center right' => 'is-position-center-right',
			'bottom left' => 'is-position-bottom-left',
			'bottom center' => 'is-position-bottom-center',
			'bottom right' => 'is-position-bottom-right',
		);
		return $map[ $position ] ?? '';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function cover_wrapper_open( array $attrs ): string {
		$classes = array( 'wp-block-cover' );
		if ( isset( $attrs['isDark'] ) && false === $attrs['isDark'] ) {
			$classes[] = 'is-light';
		}
		if ( isset( $attrs['hasParallax'] ) && true === $attrs['hasParallax'] ) {
			$classes[] = 'has-parallax';
		}
		if ( isset( $attrs['isRepeated'] ) && true === $attrs['isRepeated'] ) {
			$classes[] = 'is-repeated';
		}
		$content_position = isset( $attrs['contentPosition'] ) && is_string( $attrs['contentPosition'] ) ? trim( $attrs['contentPosition'] ) : '';
		if ( '' !== $content_position && 'center center' !== $content_position && 'center' !== $content_position ) {
			$classes[] = 'has-custom-content-position';
			$position_class = self::cover_content_position_class( $content_position );
			if ( '' !== $position_class ) {
				$classes[] = $position_class;
			}
		}
		$min_height = '';
		if ( isset( $attrs['minHeight'] ) && is_numeric( $attrs['minHeight'] ) ) {
			$min_height = (string) $attrs['minHeight'] . ( isset( $attrs['minHeightUnit'] ) && is_string( $attrs['minHeightUnit'] ) ? $attrs['minHeightUnit'] : 'px' );
		}
		return '<' . self::cover_tag_name( $attrs ) . ' class="' . implode( ' ', $classes ) . '"' . ( '' !== $min_height ? ' style="min-height:' . htmlspecialchars( $min_height, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '' ) . '>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function cover_background_html( array $attrs ): string {
		$url = isset( $attrs['url'] ) && is_string( $attrs['url'] ) ? trim( $attrs['url'] ) : '';
		$background_type = isset( $attrs['backgroundType'] ) && is_string( $attrs['backgroundType'] ) ? $attrs['backgroundType'] : 'image';
		$focal_point = isset( $attrs['focalPoint'] ) && is_array( $attrs['focalPoint'] ) ? $attrs['focalPoint'] : array();
		$object_position = self::cover_media_position( $focal_point );
		$size_slug = isset( $attrs['sizeSlug'] ) && is_string( $attrs['sizeSlug'] ) && '' !== trim( $attrs['sizeSlug'] ) ? ' size-' . htmlspecialchars( trim( $attrs['sizeSlug'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) : '';
		$id_class = isset( $attrs['id'] ) && is_int( $attrs['id'] ) && $attrs['id'] > 0 ? ' wp-image-' . $attrs['id'] : '';
		$alt = isset( $attrs['alt'] ) && is_string( $attrs['alt'] ) ? $attrs['alt'] : '';
		if ( isset( $attrs['useFeaturedImage'] ) && true === $attrs['useFeaturedImage'] ) {
			return '';
		}
		if ( 'image' === $background_type && '' !== $url ) {
			if ( ( isset( $attrs['hasParallax'] ) && true === $attrs['hasParallax'] ) || ( isset( $attrs['isRepeated'] ) && true === $attrs['isRepeated'] ) ) {
				return '<div' . ( '' !== $alt ? ' role="img" aria-label="' . htmlspecialchars( $alt, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '' ) . ' class="wp-block-cover__image-background' . $id_class . $size_slug . ( isset( $attrs['hasParallax'] ) && true === $attrs['hasParallax'] ? ' has-parallax' : '' ) . ( isset( $attrs['isRepeated'] ) && true === $attrs['isRepeated'] ? ' is-repeated' : '' ) . '" style="background-position:' . htmlspecialchars( $object_position, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . ';background-image:url(' . htmlspecialchars( $url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . ')"></div>';
			}
			return '<img class="wp-block-cover__image-background' . $id_class . $size_slug . '" alt="' . htmlspecialchars( $alt, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" src="' . htmlspecialchars( $url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" style="object-position:' . htmlspecialchars( $object_position, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" data-object-fit="cover" data-object-position="' . htmlspecialchars( $object_position, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"/>';
		}
		if ( 'video' === $background_type && '' !== $url ) {
			$poster = isset( $attrs['poster'] ) && is_string( $attrs['poster'] ) && '' !== trim( $attrs['poster'] ) ? ' poster="' . htmlspecialchars( trim( $attrs['poster'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '';
			return '<video class="wp-block-cover__video-background intrinsic-ignore" autoplay muted loop playsinline src="' . htmlspecialchars( $url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' . $poster . ' style="object-position:' . htmlspecialchars( $object_position, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" data-object-fit="cover" data-object-position="' . htmlspecialchars( $object_position, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"></video>';
		}
		if ( 'embed-video' === $background_type && '' !== $url ) {
			return '<figure class="wp-block-cover__video-background wp-block-cover__embed-background wp-block-embed"><div class="wp-block-embed__wrapper">' . htmlspecialchars( $url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '</div></figure>';
		}
		return '';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function cover_overlay_html( array $attrs ): string {
		$classes = array( 'wp-block-cover__background' );
		$overlay_color = isset( $attrs['overlayColor'] ) && is_string( $attrs['overlayColor'] ) && '' !== trim( $attrs['overlayColor'] ) ? 'has-' . htmlspecialchars( trim( $attrs['overlayColor'] ), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '-background-color' : '';
		if ( '' !== $overlay_color ) {
			$classes[] = $overlay_color;
		}
		$dim_class = self::cover_dim_ratio_class( $attrs['dimRatio'] ?? null );
		if ( '' !== $dim_class ) {
			$classes[] = $dim_class;
		}
		if ( isset( $attrs['dimRatio'] ) && is_numeric( $attrs['dimRatio'] ) ) {
			$classes[] = 'has-background-dim';
		}
		$gradient = isset( $attrs['gradient'] ) && is_string( $attrs['gradient'] ) ? trim( $attrs['gradient'] ) : '';
		$custom_gradient = isset( $attrs['customGradient'] ) && is_string( $attrs['customGradient'] ) ? trim( $attrs['customGradient'] ) : '';
		if ( '' !== $gradient || '' !== $custom_gradient ) {
			$classes[] = 'has-background-gradient';
			if ( '' !== $gradient ) {
				$classes[] = 'has-' . htmlspecialchars( $gradient, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '-gradient-background';
			}
			if ( isset( $attrs['url'] ) && is_string( $attrs['url'] ) && '' !== trim( $attrs['url'] ) && 0 !== ( $attrs['dimRatio'] ?? null ) ) {
				$classes[] = 'wp-block-cover__gradient-background';
			}
		}
		$styles = array();
		if ( '' === $overlay_color && isset( $attrs['customOverlayColor'] ) && is_string( $attrs['customOverlayColor'] ) ) {
			$styles[] = 'background-color:' . htmlspecialchars( $attrs['customOverlayColor'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		if ( '' !== $custom_gradient ) {
			$styles[] = 'background:' . htmlspecialchars( $custom_gradient, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		return '<span aria-hidden="true" class="' . implode( ' ', $classes ) . '"' . ( ! empty( $styles ) ? ' style="' . implode( ';', $styles ) . '"' : '' ) . '></span>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function normalize_heading_html( string $html, array $attrs ): string {
		$tag = self::heading_tag_name( $attrs );
		$normalized = preg_replace( '/^<h[1-6]\b/i', '<' . $tag, trim( $html ) );
		$normalized = is_string( $normalized ) ? $normalized : trim( $html );
		$normalized = preg_replace( '/<\/h[1-6]>\s*$/i', '</' . $tag . '>', $normalized );
		return is_string( $normalized ) ? $normalized : trim( $html );
	}

	/**
	 * @return array<int, string>
	 */
	private static function supported_executable_blocks(): array {
		return array(
			'core/code',
			'core/button',
			'core/buttons',
			'core/column',
			'core/columns',
			'core/details',
			'core/file',
			'core/group',
			'core/heading',
			'core/html',
			'core/image',
			'core/list',
			'core/list-item',
			'core/media-text',
			'core/more',
			'core/paragraph',
			'core/preformatted',
			'core/pullquote',
			'core/quote',
			'core/separator',
			'core/shortcode',
			'core/spacer',
			'core/table',
			'core/video',
			'core/verse',
		);
	}

	/**
	 * @return array<int, string>
	 */
	private static function wordpress_core_block_names(): array {
		return array(
			'core/accordion',
			'core/accordion-heading',
			'core/accordion-item',
			'core/accordion-panel',
			'core/archives',
			'core/audio',
			'core/avatar',
			'core/block',
			'core/breadcrumbs',
			'core/button',
			'core/buttons',
			'core/calendar',
			'core/categories',
			'core/code',
			'core/column',
			'core/columns',
			'core/comment-author-avatar',
			'core/comment-author-name',
			'core/comment-content',
			'core/comment-date',
			'core/comment-edit-link',
			'core/comment-reply-link',
			'core/comment-template',
			'core/comments',
			'core/comments-pagination',
			'core/comments-pagination-next',
			'core/comments-pagination-numbers',
			'core/comments-pagination-previous',
			'core/comments-title',
			'core/cover',
			'core/details',
			'core/embed',
			'core/file',
			'core/footnotes',
			'core/form',
			'core/form-input',
			'core/form-submission-notification',
			'core/form-submit-button',
			'core/freeform',
			'core/gallery',
			'core/group',
			'core/heading',
			'core/home-link',
			'core/html',
			'core/icon',
			'core/image',
			'core/latest-comments',
			'core/latest-posts',
			'core/list',
			'core/list-item',
			'core/loginout',
			'core/math',
			'core/media-text',
			'core/missing',
			'core/more',
			'core/navigation',
			'core/navigation-link',
			'core/navigation-overlay-close',
			'core/navigation-submenu',
			'core/nextpage',
			'core/page-list',
			'core/page-list-item',
			'core/paragraph',
			'core/pattern',
			'core/playlist',
			'core/playlist-track',
			'core/post-author',
			'core/post-author-biography',
			'core/post-author-name',
			'core/post-comment',
			'core/post-comments-count',
			'core/post-comments-form',
			'core/post-comments-link',
			'core/post-content',
			'core/post-date',
			'core/post-excerpt',
			'core/post-featured-image',
			'core/post-navigation-link',
			'core/post-template',
			'core/post-terms',
			'core/post-time-to-read',
			'core/post-title',
			'core/preformatted',
			'core/pullquote',
			'core/query',
			'core/query-no-results',
			'core/query-pagination',
			'core/query-pagination-next',
			'core/query-pagination-numbers',
			'core/query-pagination-previous',
			'core/query-title',
			'core/query-total',
			'core/quote',
			'core/read-more',
			'core/rss',
			'core/search',
			'core/separator',
			'core/shortcode',
			'core/site-logo',
			'core/site-tagline',
			'core/site-title',
			'core/social-link',
			'core/social-links',
			'core/spacer',
			'core/tab',
			'core/tab-list',
			'core/tab-panel',
			'core/tab-panels',
			'core/table',
			'core/table-of-contents',
			'core/tabs',
			'core/tag-cloud',
			'core/template-part',
			'core/term-count',
			'core/term-description',
			'core/term-name',
			'core/term-template',
			'core/terms-query',
			'core/text-columns',
			'core/verse',
			'core/video',
		);
	}

	private static function is_supported_executable_block( string $block_name ): bool {
		return in_array( $block_name, self::supported_executable_blocks(), true );
	}

	private static function unsupported_block_reason( string $block_name ): string {
		if ( in_array( $block_name, self::wordpress_core_block_names(), true ) ) {
			return 'SitePilot does not yet have explicit canonical serialization for that WordPress core block, so execution is blocked instead of inventing Gutenberg save HTML. Add it manually in the WordPress post editor for now.';
		}
		return 'SitePilot only executes an explicit allowlist of canonicalized Gutenberg blocks.';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function image_html( array $attrs ): string {
		$url = isset( $attrs['url'] ) && is_string( $attrs['url'] ) ? $attrs['url'] : '';
		if ( '' === $url ) {
			return '';
		}

		$alt            = isset( $attrs['alt'] ) && is_string( $attrs['alt'] ) ? $attrs['alt'] : '';
		$size_slug      = isset( $attrs['sizeSlug'] ) && is_string( $attrs['sizeSlug'] ) ? $attrs['sizeSlug'] : '';
		$id             = isset( $attrs['id'] ) && is_int( $attrs['id'] ) ? $attrs['id'] : 0;
		$figure_classes = array( 'wp-block-image' );
		if ( '' !== $size_slug ) {
			$figure_classes[] = 'size-' . htmlspecialchars( $size_slug, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' );
		}
		$image_class = $id > 0 ? ' class="wp-image-' . $id . '"' : '';

		return '<figure class="' . implode( ' ', $figure_classes ) . '"><img src="' . htmlspecialchars( $url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" alt="' . htmlspecialchars( $alt, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' . $image_class . '/></figure>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 * @return array{attrs: array<string, mixed>, html: string}
	 */
	private static function spacer_html( array $attrs ): array {
		$raw_height = isset( $attrs['height'] ) && ( is_string( $attrs['height'] ) || is_int( $attrs['height'] ) || is_float( $attrs['height'] ) )
			? (string) $attrs['height']
			: '100px';
		$height = preg_match( '/^\d+$/', $raw_height ) ? $raw_height . 'px' : $raw_height;
		if ( '100px' === $height ) {
			unset( $attrs['height'] );
		} else {
			$attrs['height'] = $height;
		}

		return array(
			'attrs' => $attrs,
			'html'  => '<div style="height:' . htmlspecialchars( $height, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '" aria-hidden="true" class="wp-block-spacer"></div>',
		);
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function column_wrapper_open( array $attrs ): string {
		$width = isset( $attrs['width'] ) && is_string( $attrs['width'] ) ? trim( $attrs['width'] ) : '';
		$style = '' !== $width ? ' style="flex-basis:' . htmlspecialchars( $width, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"' : '';
		return '<div class="wp-block-column"' . $style . '>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function group_wrapper_open( array $attrs ): string {
		$tag_name = self::valid_group_tag_name( $attrs );
		return '<' . $tag_name . ' class="wp-block-group">';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function group_wrapper_close( array $attrs ): string {
		return '</' . self::valid_group_tag_name( $attrs ) . '>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function details_wrapper_open( array $attrs ): string {
		$extras = array();
		if ( isset( $attrs['name'] ) && is_string( $attrs['name'] ) && '' !== trim( $attrs['name'] ) ) {
			$extras[] = 'name="' . htmlspecialchars( $attrs['name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '"';
		}
		if ( isset( $attrs['showContent'] ) && true === $attrs['showContent'] ) {
			$extras[] = 'open';
		}
		$summary = isset( $attrs['summary'] ) && is_string( $attrs['summary'] ) && '' !== trim( $attrs['summary'] )
			? $attrs['summary']
			: 'Details';
		$extra_attrs = ! empty( $extras ) ? ' ' . implode( ' ', $extras ) : '';
		return '<details class="wp-block-details"' . $extra_attrs . '><summary>' . htmlspecialchars( $summary, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ) . '</summary>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function list_wrapper_open( array $attrs ): string {
		$ordered = isset( $attrs['ordered'] ) && true === $attrs['ordered'];
		$tag_name = $ordered ? 'ol' : 'ul';
		$extras = array();
		if ( $ordered && isset( $attrs['reversed'] ) && true === $attrs['reversed'] ) {
			$extras[] = 'reversed';
		}
		if ( $ordered && isset( $attrs['start'] ) && is_int( $attrs['start'] ) ) {
			$extras[] = 'start="' . (string) $attrs['start'] . '"';
		}
		$extra_attrs = ! empty( $extras ) ? ' ' . implode( ' ', $extras ) : '';
		return '<' . $tag_name . ' class="wp-block-list"' . $extra_attrs . '>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 */
	private static function list_wrapper_close( array $attrs ): string {
		return ( isset( $attrs['ordered'] ) && true === $attrs['ordered'] ) ? '</ol>' : '</ul>';
	}

	/**
	 * @param array<string, mixed> $attrs Block attrs.
	 * @param array<int, array<string, mixed>> $inner_blocks Inner blocks.
	 * @return array<int, string|null>|null
	 */
	private static function canonical_container_inner_content( string $block_name, array $attrs, array $inner_blocks ): ?array {
		if ( 'core/columns' === $block_name ) {
			$inner_content = array( '<div class="wp-block-columns">' );
			foreach ( $inner_blocks as $index => $_block ) {
				if ( $index > 0 ) {
					$inner_content[] = "\n\n";
				}
				$inner_content[] = null;
			}
			$inner_content[] = '</div>';
			return $inner_content;
		}

		if ( 'core/column' === $block_name ) {
			return array_merge(
				array( self::column_wrapper_open( $attrs ) ),
				array_fill( 0, count( $inner_blocks ), null ),
				array( '</div>' )
			);
		}

		if ( 'core/buttons' === $block_name ) {
			$inner_content = array( '<div class="wp-block-buttons">' );
			foreach ( $inner_blocks as $index => $_block ) {
				if ( $index > 0 ) {
					$inner_content[] = "\n\n";
				}
				$inner_content[] = null;
			}
			$inner_content[] = '</div>';
			return $inner_content;
		}

		if ( 'core/group' === $block_name ) {
			return array_merge(
				array( self::group_wrapper_open( $attrs ) ),
				array_fill( 0, count( $inner_blocks ), null ),
				array( self::group_wrapper_close( $attrs ) )
			);
		}

		if ( 'core/details' === $block_name ) {
			return array_merge(
				array( self::details_wrapper_open( $attrs ) ),
				array_fill( 0, count( $inner_blocks ), null ),
				array( '</details>' )
			);
		}

		if ( 'core/cover' === $block_name ) {
			return array_merge(
				array(
					self::cover_wrapper_open( $attrs ),
					self::cover_background_html( $attrs ),
					self::cover_overlay_html( $attrs ),
					'<div class="wp-block-cover__inner-container">'
				),
				array_fill( 0, count( $inner_blocks ), null ),
				array( '</div>', '</' . self::cover_tag_name( $attrs ) . '>' )
			);
		}

		if ( 'core/media-text' === $block_name ) {
			if ( isset( $attrs['mediaPosition'] ) && 'right' === $attrs['mediaPosition'] ) {
				return array_merge(
					array( self::media_text_wrapper_open( $attrs ), '<div class="wp-block-media-text__content">' ),
					array_fill( 0, count( $inner_blocks ), null ),
					array( '</div>', self::media_text_media_figure_html( $attrs ), '</div>' )
				);
			}
			return array_merge(
				array( self::media_text_wrapper_open( $attrs ), self::media_text_media_figure_html( $attrs ), '<div class="wp-block-media-text__content">' ),
				array_fill( 0, count( $inner_blocks ), null ),
				array( '</div>', '</div>' )
			);
		}

		if ( 'core/list' === $block_name ) {
			return array_merge(
				array( self::list_wrapper_open( $attrs ) ),
				array_fill( 0, count( $inner_blocks ), null ),
				array( self::list_wrapper_close( $attrs ) )
			);
		}

		return null;
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function resolve_post_content_input( array $input ): array {
		if ( array_key_exists( 'blocks', $input ) ) {
			if ( ! is_array( $input['blocks'] ) ) {
				return self::invalid_blocks( 'blocks must be an array' );
			}

			if ( empty( $input['blocks'] ) ) {
				return self::invalid_blocks( 'blocks must not be empty' );
			}

			$blocks = array();
			foreach ( $input['blocks'] as $index => $block ) {
				$sanitized = self::sanitize_parsed_block( $block, 'blocks[' . $index . ']' );
				if ( ! $sanitized['ok'] ) {
					return $sanitized;
				}
				$blocks[] = $sanitized['block'];
			}

			return array(
				'ok'      => true,
				'content' => serialize_blocks( $blocks ),
				'blocks'  => $blocks,
			);
		}

		return array(
			'ok'      => true,
			'content' => isset( $input['content'] ) ? wp_kses_post( (string) $input['content'] ) : '',
		);
	}

	/**
	 * @param string $content Serialized post content.
	 * @return array<string, mixed>
	 */
	private static function split_top_level_serialized_segments( string $content ): array {
		$segments = array();
		$cursor   = 0;
		$length   = strlen( $content );
		$pattern  = '/<!--\s*(\/?)wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+([\s\S]*?))?\s*(\/)?-->/i';

		while ( preg_match( $pattern, $content, $match, PREG_OFFSET_CAPTURE, $cursor ) ) {
			$is_closing = isset( $match[1][0] ) && '/' === $match[1][0];
			$start      = (int) $match[0][1];
			if ( $is_closing ) {
				return array(
					'ok'    => false,
					'error' => 'unexpected closing block delimiter while scanning existing post_content',
				);
			}

			if ( $start > $cursor ) {
				$segments[] = array(
					'type' => 'raw',
					'raw'  => substr( $content, $cursor, $start - $cursor ),
				);
			}

			$block_name = self::normalize_block_name( (string) $match[2][0] );
			$end        = self::find_serialized_block_end( $content, $start );
			if ( null === $end ) {
				return array(
					'ok'    => false,
					'error' => 'unbalanced block delimiters in existing post_content',
				);
			}

			$segments[] = array(
				'type'      => 'block',
				'blockName' => $block_name,
				'raw'       => substr( $content, $start, $end - $start ),
			);
			$cursor = $end;
		}

		if ( $cursor < $length ) {
			$segments[] = array(
				'type' => 'raw',
				'raw'  => substr( $content, $cursor ),
			);
		}

		return array(
			'ok'       => true,
			'segments' => $segments,
		);
	}

	/**
	 * @param string $content Serialized post content.
	 * @param int    $start_offset Offset of the opening delimiter.
	 * @return int|null
	 */
	private static function find_serialized_block_end( string $content, int $start_offset ): ?int {
		$pattern = '/<!--\s*(\/?)wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+([\s\S]*?))?\s*(\/)?-->/i';
		$offset  = $start_offset;
		$stack   = array();

		while ( preg_match( $pattern, $content, $match, PREG_OFFSET_CAPTURE, $offset ) ) {
			$is_closing   = isset( $match[1][0] ) && '/' === $match[1][0];
			$raw_name     = (string) $match[2][0];
			$full_match   = (string) $match[0][0];
			$match_offset = (int) $match[0][1];
			$match_end    = $match_offset + strlen( $full_match );
			$self_closing = isset( $match[4][0] ) && '/' === $match[4][0];

			if ( $match_offset < $start_offset ) {
				$offset = $match_end;
				continue;
			}

			if ( $is_closing ) {
				if ( empty( $stack ) ) {
					return null;
				}
				$open = array_pop( $stack );
				if ( $open !== $raw_name ) {
					return null;
				}
				if ( empty( $stack ) ) {
					return $match_end;
				}
				$offset = $match_end;
				continue;
			}

			if ( $self_closing ) {
				if ( empty( $stack ) ) {
					return $match_end;
				}
				$offset = $match_end;
				continue;
			}

			$stack[] = $raw_name;
			$offset  = $match_end;
		}

		return null;
	}

	/**
	 * @param string                          $existing_content Existing serialized post content.
	 * @param array<int, array<string, mixed>> $incoming_blocks Incoming parsed blocks.
	 * @return array<string, mixed>
	 */
	private static function merge_blocks_into_existing_content( string $existing_content, array $incoming_blocks ): array {
		if ( '' === trim( $existing_content ) ) {
			return array(
				'ok'      => true,
				'content' => serialize_blocks( $incoming_blocks ),
			);
		}

		$split = self::split_top_level_serialized_segments( $existing_content );
		if ( ! $split['ok'] ) {
			return array(
				'ok'    => false,
				'error' => 'merge_blocks_failed: ' . $split['error'],
			);
		}

		$segments = $split['segments'];
		$used     = array();

		foreach ( $incoming_blocks as $incoming_block ) {
			$incoming_name = isset( $incoming_block['blockName'] ) ? self::normalize_block_name( (string) $incoming_block['blockName'] ) : '';
			$matches       = array();

			foreach ( $segments as $index => $segment ) {
				if ( ! is_array( $segment ) || 'block' !== ( $segment['type'] ?? '' ) ) {
					continue;
				}
				if ( $incoming_name !== ( $segment['blockName'] ?? '' ) ) {
					continue;
				}
				if ( in_array( $index, $used, true ) ) {
					continue;
				}
				$matches[] = $index;
			}

			if ( 1 !== count( $matches ) ) {
				return array(
					'ok'    => false,
					'error' => 'merge_blocks_failed: could not uniquely match existing top-level block "' . $incoming_name . '" for update',
				);
			}

			$match_index                    = $matches[0];
			$segments[ $match_index ]['raw'] = serialize_blocks( array( $incoming_block ) );
			$used[]                         = $match_index;
		}

		return array(
			'ok'      => true,
			'content' => implode(
				'',
				array_map(
					static function ( array $segment ): string {
						return isset( $segment['raw'] ) ? (string) $segment['raw'] : '';
					},
					$segments
				)
			),
		);
	}

	/**
	 * @param string $message Validation detail.
	 * @return array<string, mixed>
	 */
	private static function invalid_blocks( string $message ): array {
		return array(
			'ok'    => false,
			'error' => 'invalid_blocks: ' . $message,
		);
	}

	/**
	 * @param mixed $value Block attrs value.
	 * @return mixed
	 */
	private static function sanitize_block_attrs( $value ) {
		if ( is_array( $value ) ) {
			$sanitized = array();
			foreach ( $value as $key => $inner_value ) {
				$sanitized[ $key ] = self::sanitize_block_attrs( $inner_value );
			}
			return $sanitized;
		}

		if ( is_string( $value ) ) {
			return sanitize_text_field( $value );
		}

		if ( is_int( $value ) || is_float( $value ) || is_bool( $value ) || null === $value ) {
			return $value;
		}

		return null;
	}

	/**
	 * @param string $block_name Block name.
	 * @param array<string, mixed> $attrs Block attrs.
	 * @param string $path Path used in validation messages.
	 * @return string|null
	 */
	private static function validate_media_urls( string $block_name, array $attrs, string $path ): ?string {
		$media_blocks = array(
			'core/audio',
			'core/cover',
			'core/file',
			'core/gallery',
			'core/image',
			'core/media-text',
			'core/video',
		);

		if ( ! in_array( $block_name, $media_blocks, true ) ) {
			return null;
		}

		return self::validate_media_url_values( $attrs, $path );
	}

	/**
	 * @param array<string, mixed> $value Attr values.
	 * @param string $path Path used in validation messages.
	 * @return string|null
	 */
	private static function validate_media_url_values( array $value, string $path ): ?string {
		foreach ( $value as $key => $inner_value ) {
			$inner_path = $path . '.' . (string) $key;
			if ( is_array( $inner_value ) ) {
				$error = self::validate_media_url_values( $inner_value, $inner_path );
				if ( null !== $error ) {
					return $error;
				}
				continue;
			}

			if ( ! is_string( $inner_value ) ) {
				continue;
			}

			$key_lower = strtolower( (string) $key );
			if ( ! str_contains( $key_lower, 'url' ) && ! str_contains( $key_lower, 'src' ) ) {
				continue;
			}

			if ( str_starts_with( $inner_value, '//' ) ) {
				return $inner_path . ' must be an HTTPS URL';
			}

			$scheme = wp_parse_url( $inner_value, PHP_URL_SCHEME );
			if ( is_string( $scheme ) && strtolower( $scheme ) !== 'https' ) {
				return $inner_path . ' must be an HTTPS URL';
			}
		}

		return null;
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

		if ( ! $content['ok'] ) {
			return array(
				'ok'          => false,
				'dry_run'     => $dry_run,
				'post_id'     => 0,
				'post_type'   => $ptype,
				'post_status' => 'draft',
				'error'       => $content['error'],
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
					'post_content' => $content['content'],
					'post_status'  => 'draft',
				),
			);
		}

		$post_id = wp_insert_post(
			array(
				'post_type'    => $ptype,
				'post_title'   => $title,
				'post_content' => $content['content'],
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
			'after'                 => array(
				'post_title'   => get_post_field( 'post_title', (int) $post_id ),
				'post_content' => get_post_field( 'post_content', (int) $post_id ),
				'post_status'  => get_post_status( (int) $post_id ),
			),
		);
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function exec_upload_media_asset( array $input ): array {
		$dry_run   = ! empty( $input['dry_run'] );
		$file_name = sanitize_file_name( wp_basename( (string) ( $input['file_name'] ?? '' ) ) );
		$media_type = sanitize_text_field( (string) ( $input['media_type'] ?? '' ) );
		$data_base64 = preg_replace( '/\s+/', '', (string) ( $input['data_base64'] ?? '' ) ) ?? '';
		$alt_text = sanitize_text_field( (string) ( $input['alt_text'] ?? '' ) );

		if ( '' === $file_name ) {
			return array(
				'ok'         => false,
				'dry_run'    => $dry_run,
				'file_name'  => '',
				'media_type' => $media_type,
				'error'      => 'file_name_required',
			);
		}

		if ( '' === $media_type || ! str_starts_with( strtolower( $media_type ), 'image/' ) ) {
			return array(
				'ok'         => false,
				'dry_run'    => $dry_run,
				'file_name'  => $file_name,
				'media_type' => $media_type,
				'error'      => 'invalid_media_type',
			);
		}

		if ( '' === $data_base64 ) {
			return array(
				'ok'         => false,
				'dry_run'    => $dry_run,
				'file_name'  => $file_name,
				'media_type' => $media_type,
				'error'      => 'data_base64_required',
			);
		}

		$binary = base64_decode( $data_base64, true );
		if ( false === $binary ) {
			return array(
				'ok'         => false,
				'dry_run'    => $dry_run,
				'file_name'  => $file_name,
				'media_type' => $media_type,
				'error'      => 'invalid_data_base64',
			);
		}

		$bytes = strlen( $binary );
		if ( $dry_run ) {
			return array(
				'ok'         => true,
				'dry_run'    => true,
				'file_name'  => $file_name,
				'media_type' => $media_type,
				'bytes'      => $bytes,
				'preview'    => array(
					'file_name'  => $file_name,
					'media_type' => $media_type,
					'bytes'      => $bytes,
					'alt_text'   => $alt_text,
				),
			);
		}

		$upload = wp_upload_bits( $file_name, null, $binary );
		if ( ! is_array( $upload ) || ! empty( $upload['error'] ) ) {
			return array(
				'ok'         => false,
				'dry_run'    => false,
				'file_name'  => $file_name,
				'media_type' => $media_type,
				'bytes'      => $bytes,
				'error'      => is_array( $upload ) && isset( $upload['error'] ) ? (string) $upload['error'] : 'upload_failed',
			);
		}

		$attachment = array(
			'post_mime_type' => $media_type,
			'post_title'     => pathinfo( $file_name, PATHINFO_FILENAME ),
			'post_content'   => '',
			'post_status'    => 'inherit',
			'guid'           => (string) $upload['url'],
		);

		$attachment_id = wp_insert_attachment( $attachment, (string) $upload['file'] );
		if ( is_wp_error( $attachment_id ) ) {
			return array(
				'ok'         => false,
				'dry_run'    => false,
				'file_name'  => $file_name,
				'media_type' => $media_type,
				'bytes'      => $bytes,
				'error'      => $attachment_id->get_error_message(),
			);
		}

		if ( '' !== $alt_text ) {
			update_post_meta( (int) $attachment_id, '_wp_attachment_image_alt', $alt_text );
		}

		if ( defined( 'ABSPATH' ) ) {
			$admin_file = ABSPATH . 'wp-admin/includes/image.php';
			if ( file_exists( $admin_file ) ) {
				require_once $admin_file;
			}
		}

		if ( function_exists( 'wp_generate_attachment_metadata' ) && function_exists( 'wp_update_attachment_metadata' ) ) {
			$metadata = wp_generate_attachment_metadata( (int) $attachment_id, (string) $upload['file'] );
			if ( ! is_wp_error( $metadata ) && is_array( $metadata ) ) {
				wp_update_attachment_metadata( (int) $attachment_id, $metadata );
			}
		}

		return array(
			'ok'            => true,
			'dry_run'       => false,
			'attachment_id' => (int) $attachment_id,
			'url'           => (string) $upload['url'],
			'file_name'     => $file_name,
			'media_type'    => $media_type,
			'bytes'         => $bytes,
		);
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function exec_update_post_fields( array $input ): array {
		$dry_run         = ! empty( $input['dry_run'] );
		$replace_content = ! empty( $input['replace_content'] );
		$post_id         = absint( $input['post_id'] );
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
			$content = self::resolve_post_content_input( $input );
			if ( ! $content['ok'] ) {
				return array(
					'ok'      => false,
					'dry_run' => $dry_run,
					'post_id' => $post_id,
					'error'   => $content['error'],
				);
			}
			if ( array_key_exists( 'blocks', $input ) && ! $replace_content && isset( $content['blocks'] ) && is_array( $content['blocks'] ) ) {
				$merged = self::merge_blocks_into_existing_content( $before['post_content'], $content['blocks'] );
				if ( ! $merged['ok'] ) {
					return array(
						'ok'      => false,
						'dry_run' => $dry_run,
						'post_id' => $post_id,
						'error'   => $merged['error'],
					);
				}
				$after['post_content'] = $merged['content'];
			} else {
				$after['post_content'] = $content['content'];
			}
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

		$provider  = self::normalize_seo_meta_provider( $input['meta_provider'] ?? '' );
		$key_title = 'yoast' === $provider ? '_yoast_wpseo_title' : '_sitepilot_seo_title';
		$key_desc  = 'yoast' === $provider ? '_yoast_wpseo_metadesc' : '_sitepilot_seo_description';

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
				'meta_provider' => $provider,
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
			'meta_provider' => $provider,
			'before'  => $before,
			'after'   => array(
				$key_title => (string) get_post_meta( $post_id, $key_title, true ),
				$key_desc  => (string) get_post_meta( $post_id, $key_desc, true ),
			),
		);
	}

	/**
	 * @param array<string, mixed> $input Input.
	 * @return array<string, mixed>
	 */
	private static function exec_set_post_featured_image( array $input ): array {
		$dry_run       = ! empty( $input['dry_run'] );
		$post_id       = absint( $input['post_id'] );
		$attachment_id = absint( $input['attachment_id'] ?? 0 );
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

		if ( $attachment_id < 1 ) {
			return array(
				'ok'      => false,
				'dry_run' => $dry_run,
				'post_id' => $post_id,
				'error'   => 'missing_attachment_id',
			);
		}

		$attachment = get_post( $attachment_id );
		if ( ! $attachment instanceof \WP_Post ) {
			return array(
				'ok'            => false,
				'dry_run'       => $dry_run,
				'post_id'       => $post_id,
				'attachment_id' => $attachment_id,
				'error'         => 'attachment_not_found',
			);
		}

		$before = array(
			'_thumbnail_id' => (string) get_post_meta( $post_id, '_thumbnail_id', true ),
		);
		$after = array(
			'_thumbnail_id' => (string) $attachment_id,
		);

		if ( $dry_run ) {
			return array(
				'ok'            => true,
				'dry_run'       => true,
				'post_id'       => $post_id,
				'attachment_id' => $attachment_id,
				'before'        => $before,
				'after'         => $after,
			);
		}

		update_post_meta( $post_id, '_thumbnail_id', (string) $attachment_id );

		return array(
			'ok'            => true,
			'dry_run'       => false,
			'post_id'       => $post_id,
			'attachment_id' => $attachment_id,
			'before'        => $before,
			'after'         => array(
				'_thumbnail_id' => (string) get_post_meta( $post_id, '_thumbnail_id', true ),
			),
		);
	}

	private static function normalize_seo_meta_provider( $provider ): string {
		return 'yoast' === sanitize_key( (string) $provider ) ? 'yoast' : 'sitepilot';
	}
}
