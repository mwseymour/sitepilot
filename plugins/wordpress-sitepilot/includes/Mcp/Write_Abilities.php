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
				$inner_content[] = wp_kses_post( self::normalize_text_chunk( $chunk, $block_name ) );
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

		if ( 'core/separator' === $block_name ) {
			$inner_html    = self::separator_html( $attrs );
			$inner_content = array( $inner_html );
		}

		if ( 'core/verse' === $block_name ) {
			$inner_html    = self::verse_html( $inner_html );
			$inner_content = array( $inner_html );
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
			'core/column',
			'core/columns',
			'core/heading',
			'core/image',
			'core/paragraph',
			'core/preformatted',
			'core/quote',
			'core/separator',
			'core/spacer',
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
			return 'SitePilot does not yet have explicit canonical serialization for that WordPress core block, so execution is blocked instead of inventing Gutenberg save HTML.';
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
			);
		}

		return array(
			'ok'      => true,
			'content' => isset( $input['content'] ) ? wp_kses_post( (string) $input['content'] ) : '',
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
			$content = self::resolve_post_content_input( $input );
			if ( ! $content['ok'] ) {
				return array(
					'ok'      => false,
					'dry_run' => $dry_run,
					'post_id' => $post_id,
					'error'   => $content['error'],
				);
			}
			$after['post_content'] = $content['content'];
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
