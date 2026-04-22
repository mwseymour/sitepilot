<?php
declare( strict_types = 1 );

namespace SitePilot\Registration {
	final class Store {
		public static function get_site( string $site_id ): ?array {
			return $site_id === '' ? null : array( 'id' => $site_id );
		}
	}
}

namespace SitePilot\Security {
	final class Signed_Request_Verifier {
		public static function get_authenticated_site_id(): string {
			return 'site-1';
		}
	}
}

namespace {
	require_once __DIR__ . '/../vendor/autoload.php';

	if ( ! class_exists( 'WP_Post' ) ) {
		class WP_Post {
			public int $ID;
			public string $post_title;
			public string $post_content;
			public string $post_excerpt;

			public function __construct( int $id, string $title, string $content, string $excerpt = '' ) {
				$this->ID           = $id;
				$this->post_title   = $title;
				$this->post_content = $content;
				$this->post_excerpt = $excerpt;
			}
		}
	}

	if ( ! class_exists( 'WP_Post_Type' ) ) {
		class WP_Post_Type {
			public object $cap;

			public function __construct() {
				$this->cap = (object) array( 'create_posts' => 'edit_posts' );
			}
		}
	}

	if ( ! class_exists( 'WP_Error' ) ) {
		class WP_Error {
			private string $message;

			public function __construct( string $message ) {
				$this->message = $message;
			}

			public function get_error_message(): string {
				return $this->message;
			}
		}
	}

	$GLOBALS['sitepilot_test_posts'] = array(
		12 => new WP_Post( 12, 'Existing title', '<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->', 'Old excerpt' ),
	);

	function __( string $text, string $domain = '' ): string {
		unset( $domain );
		return $text;
	}

	function add_action( string $hook, callable $callback, int $priority = 10 ): void {
		unset( $hook, $callback, $priority );
	}

	function current_user_can( string $capability, int $post_id = 0 ): bool {
		unset( $capability, $post_id );
		return true;
	}

	function sanitize_text_field( string $value ): string {
		return trim( strip_tags( $value ) );
	}

	function sanitize_textarea_field( string $value ): string {
		return trim( strip_tags( $value ) );
	}

	function sanitize_key( string $value ): string {
		return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( $value ) ) ?? '';
	}

	function wp_kses_post( string $value ): string {
		return preg_replace( '#<script\b[^>]*>.*?</script>#is', '', $value ) ?? '';
	}

	function wp_parse_url( string $url, int $component = -1 ): mixed {
		return parse_url( $url, $component );
	}

	function post_type_exists( string $post_type ): bool {
		return in_array( $post_type, array( 'post', 'page' ), true );
	}

	function get_post_type_object( string $post_type ): ?WP_Post_Type {
		return post_type_exists( $post_type ) ? new WP_Post_Type() : null;
	}

	function absint( mixed $value ): int {
		return abs( (int) $value );
	}

	function get_post( int $post_id ): ?WP_Post {
		return $GLOBALS['sitepilot_test_posts'][ $post_id ] ?? null;
	}

	function wp_insert_post( array $post, bool $wp_error = false ): int|WP_Error {
		unset( $wp_error );
		$post_id                                  = 100;
		$GLOBALS['sitepilot_test_posts'][ $post_id ] = new WP_Post(
			$post_id,
			(string) ( $post['post_title'] ?? '' ),
			(string) ( $post['post_content'] ?? '' )
		);
		return $post_id;
	}

	function wp_update_post( array $post, bool $wp_error = false ): int|WP_Error {
		unset( $wp_error );
		$post_id = (int) ( $post['ID'] ?? 0 );
		if ( ! isset( $GLOBALS['sitepilot_test_posts'][ $post_id ] ) ) {
			return new WP_Error( 'post_not_found' );
		}
		if ( array_key_exists( 'post_title', $post ) ) {
			$GLOBALS['sitepilot_test_posts'][ $post_id ]->post_title = (string) $post['post_title'];
		}
		if ( array_key_exists( 'post_content', $post ) ) {
			$GLOBALS['sitepilot_test_posts'][ $post_id ]->post_content = (string) $post['post_content'];
		}
		if ( array_key_exists( 'post_excerpt', $post ) ) {
			$GLOBALS['sitepilot_test_posts'][ $post_id ]->post_excerpt = (string) $post['post_excerpt'];
		}
		return $post_id;
	}

	function is_wp_error( mixed $value ): bool {
		return $value instanceof WP_Error;
	}

	function get_post_field( string $field, int $post_id ): string {
		$post = get_post( $post_id );
		return $post instanceof WP_Post ? (string) $post->{$field} : '';
	}

	function get_post_status( int $post_id ): string {
		unset( $post_id );
		return 'draft';
	}

	function get_post_meta( int $post_id, string $key, bool $single = true ): string {
		unset( $post_id, $key, $single );
		return '';
	}

	function update_post_meta( int $post_id, string $key, string $value ): void {
		unset( $post_id, $key, $value );
	}

	function serialize_blocks( array $blocks ): string {
		return implode( "\n", array_map( 'serialize_block', $blocks ) );
	}

	function serialize_block( array $block ): string {
		$block_name = (string) $block['blockName'];
		$comment    = str_starts_with( $block_name, 'core/' ) ? substr( $block_name, 5 ) : $block_name;
		$attrs      = $block['attrs'] ?? array();
		$attrs_json = ! empty( $attrs ) ? ' ' . wp_json_encode( $attrs ) : '';
		$content    = '';
		$inner_i    = 0;

		foreach ( $block['innerContent'] ?? array() as $chunk ) {
			if ( null === $chunk ) {
				$inner = $block['innerBlocks'][ $inner_i ] ?? null;
				if ( is_array( $inner ) ) {
					$content .= serialize_block( $inner );
				}
				++$inner_i;
				continue;
			}
			$content .= (string) $chunk;
		}

		if ( '' === $content && isset( $block['innerHTML'] ) ) {
			$content = (string) $block['innerHTML'];
		}

		return '<!-- wp:' . $comment . $attrs_json . ' -->' . $content . '<!-- /wp:' . $comment . ' -->';
	}

	function wp_json_encode( mixed $value ): string {
		return json_encode( $value, JSON_UNESCAPED_SLASHES ) ?: '';
	}
}
