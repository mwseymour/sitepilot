<?php
declare( strict_types = 1 );

namespace SitePilot\Registration {
	/**
	 * Test double. Tests that set $GLOBALS['sitepilot_test_sites'] get a real
	 * in-memory store; otherwise every non-empty site ID is registered.
	 */
	final class Store {
		public static function get_site( string $site_id ): ?array {
			if ( isset( $GLOBALS['sitepilot_test_sites'] ) ) {
				return $GLOBALS['sitepilot_test_sites'][ $site_id ] ?? null;
			}
			return $site_id === '' ? null : array( 'id' => $site_id );
		}

		public static function get_row( string $site_id ): ?array {
			return self::get_site( $site_id );
		}

		public static function save_site( string $site_id, array $record ): void {
			$GLOBALS['sitepilot_test_sites'][ $site_id ] = $record;
		}
	}
}

namespace SitePilot\Security {
	/**
	 * Test double. $GLOBALS['sitepilot_test_signed'] decides whether a request
	 * verifies, and each verification is counted.
	 */
	final class Signed_Request_Verifier {
		public static function get_authenticated_site_id(): string {
			return $GLOBALS['sitepilot_test_site_id'] ?? 'site-1';
		}

		public static function verify_mcp_request( $request ): bool {
			unset( $request );
			$GLOBALS['sitepilot_test_verifications'] = ( $GLOBALS['sitepilot_test_verifications'] ?? 0 ) + 1;
			return (bool) ( $GLOBALS['sitepilot_test_signed'] ?? false );
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
			public string $post_status = 'publish';
			public string $post_type = 'post';
			public string $post_name = '';
			public string $post_date_gmt = '';
			public string $post_modified_gmt = '';

			public function __construct( int $id, string $title, string $content, string $excerpt = '', string $status = 'publish' ) {
				$this->ID           = $id;
				$this->post_title   = $title;
				$this->post_content = $content;
				$this->post_excerpt = $excerpt;
				$this->post_status  = $status;
			}
		}
	}

	if ( ! class_exists( 'WP_Post_Type' ) ) {
		class WP_Post_Type {
			public object $cap;

			public function __construct() {
				$this->cap = (object) array( 'create_posts' => 'edit_posts', 'publish_posts' => 'publish_posts' );
			}
		}
	}

	if ( ! class_exists( 'WP_Term' ) ) {
		class WP_Term {
			public function __construct( public int $term_id, public string $slug, public string $name, public int $parent = 0, public int $count = 0 ) {}
		}
	}

	if ( ! class_exists( 'WP_Taxonomy' ) ) {
		class WP_Taxonomy {
			public object $cap;

			public function __construct( public string $name, public bool $public = true, public bool $hierarchical = false ) {
				$this->cap = (object) array(
					'assign_terms' => 'post_tag' === $name ? 'assign_post_tags' : 'assign_categories',
					'edit_terms'   => 'post_tag' === $name ? 'manage_post_tags' : 'manage_categories',
				);
			}
		}
	}

	if ( ! class_exists( 'WP_Error' ) ) {
		class WP_Error {
			/**
			 * Accepts (message) as older tests use it, or WordPress's (code,
			 * message, data). get_error_message() returns the first argument,
			 * which older tests compare against error codes.
			 */
			public function __construct( private string $code, private string $text = '', private mixed $data = null ) {}

			public function get_error_message(): string {
				return $this->code;
			}

			public function get_error_code(): string {
				return $this->code;
			}

			public function get_error_data(): mixed {
				return $this->data;
			}
		}
	}

	$GLOBALS['sitepilot_test_posts'] = array(
		12 => new WP_Post( 12, 'Existing title', '<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->', 'Old excerpt' ),
	);
	$GLOBALS['sitepilot_test_uploads'] = array();
	$GLOBALS['sitepilot_test_attachment_meta'] = array();
	$GLOBALS['sitepilot_test_post_meta'] = array();

	function __( string $text, string $domain = '' ): string {
		unset( $domain );
		return $text;
	}

	function add_action( string $hook, callable $callback, int $priority = 10 ): void {
		unset( $hook, $callback, $priority );
	}

	function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
		unset( $hook, $args );
		return $value;
	}

	function wp_slash( mixed $value ): mixed {
		if ( is_array( $value ) ) {
			return array_map( 'wp_slash', $value );
		}
		return is_string( $value ) ? addslashes( $value ) : $value;
	}

	function wp_unslash( mixed $value ): mixed {
		if ( is_array( $value ) ) {
			return array_map( 'wp_unslash', $value );
		}
		return is_string( $value ) ? stripslashes( $value ) : $value;
	}

	function maybe_serialize( mixed $value ): string {
		return serialize( $value );
	}

	// Capabilities a test has taken away from the current user.
	$GLOBALS['sitepilot_test_denied_caps'] = array();

	function current_user_can( string $capability, int $post_id = 0 ): bool {
		unset( $post_id );
		return ! in_array( $capability, $GLOBALS['sitepilot_test_denied_caps'], true );
	}

	// Mirrors WordPress: strips tags and %-encoded octets, joins lines and
	// collapses whitespace.
	function sanitize_text_field( string $value ): string {
		$value = strip_tags( $value );
		$value = (string) preg_replace( '/%[a-f0-9]{2}/i', '', $value );
		return trim( (string) preg_replace( '/[\r\n\t ]+/', ' ', $value ) );
	}

	function sanitize_file_name( string $value ): string {
		$value = trim( $value );
		return preg_replace( '/[^A-Za-z0-9._-]/', '-', $value ) ?? '';
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

	function acf_get_field_groups(): array {
		return array(
			array(
				'key'      => 'group_container',
				'location' => array(
					array(
						array(
							'param'    => 'block',
							'operator' => '==',
							'value'    => 'acf/container',
						),
					),
				),
			),
		);
	}

	$GLOBALS['sitepilot_test_options'] = array();

	function get_option( string $name, mixed $default = false ): mixed {
		return $GLOBALS['sitepilot_test_options'][ $name ] ?? $default;
	}

	function update_option( string $name, mixed $value, mixed $autoload = null ): bool {
		unset( $autoload );
		$GLOBALS['sitepilot_test_options'][ $name ] = $value;
		return true;
	}

	define( 'ACF_VERSION', '6.8.3' );

	function acf_get_block_types(): array {
		return array(
			'acf/container' => array(
				'title'    => 'Container',
				'mode'     => 'preview',
				'supports' => array(
					'align' => true,
					'jsx'   => true,
				),
			),
		);
	}

	function acf_get_fields( array $group ): array {
		unset( $group );
		return array(
			array(
				'key'           => 'field_container_colour',
				'name'          => 'colour',
				'label'         => 'Colour',
				'type'          => 'select',
				'default_value' => 'white',
				'choices'       => array(
					'bg-white'    => 'white',
					'bg-gray-300' => 'grey',
				),
			),
			array(
				'key'           => 'field_container_padding_amount',
				'name'          => 'padding_amount',
				'label'         => 'Padding Amount',
				'type'          => 'select',
				'default_value' => 'normal',
				'choices'       => array(
					'py-0'                    => 'none',
					'py-[80px] md:py-[100px]' => 'normal',
				),
			),
			array(
				'key'           => 'field_container_bottom_border',
				'name'          => 'bottom_border',
				'label'         => 'Bottom Border',
				'type'          => 'true_false',
				'default_value' => 1,
			),
		);
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

	if ( ! class_exists( 'WP_User' ) ) {
		class WP_User {
			public function __construct( public int $ID, public string $user_login = '' ) {}
		}
	}

	if ( ! class_exists( 'WP_REST_Request' ) ) {
		class WP_REST_Request {
			/** @param array<string, mixed> $json */
			public function __construct( private array $json = array() ) {}

			/** @return array<string, mixed> */
			public function get_json_params(): array {
				return $this->json;
			}
		}
	}

	// Users by ID and login, and the current user.
	$GLOBALS['sitepilot_test_users']        = array();
	$GLOBALS['sitepilot_test_current_user'] = 0;

	function get_user_by( string $field, int|string $value ): WP_User|false {
		foreach ( $GLOBALS['sitepilot_test_users'] as $user ) {
			if ( ( 'id' === $field && $user->ID === (int) $value ) || ( 'login' === $field && $user->user_login === $value ) ) {
				return $user;
			}
		}
		return false;
	}

	function user_can( WP_User $user, string $capability ): bool {
		unset( $user );
		return ! in_array( $capability, $GLOBALS['sitepilot_test_denied_caps'], true );
	}

	function wp_set_current_user( int $user_id ): void {
		$GLOBALS['sitepilot_test_current_user'] = $user_id;
	}

	function get_current_user_id(): int {
		return $GLOBALS['sitepilot_test_current_user'];
	}

	function wp_generate_password( int $length = 12, bool $special = true, bool $extra = false ): string {
		unset( $special, $extra );
		return substr( bin2hex( random_bytes( $length ) ), 0, $length );
	}

	function wp_cache_delete( string $key, string $group = '' ): bool {
		unset( $key, $group );
		return true;
	}

	function add_option( string $name, mixed $value = '', string $deprecated = '', mixed $autoload = null ): bool {
		unset( $deprecated, $autoload );
		if ( array_key_exists( $name, $GLOBALS['sitepilot_test_options'] ) ) {
			return false;
		}
		$GLOBALS['sitepilot_test_options'][ $name ] = $value;
		return true;
	}

	function get_the_title( WP_Post|int $post ): string {
		return $post instanceof WP_Post ? $post->post_title : '';
	}

	function get_permalink( WP_Post|int $post ): string {
		return 'https://example.test/?p=' . ( $post instanceof WP_Post ? $post->ID : $post );
	}

	function get_the_category( int $post_id ): array {
		unset( $post_id );
		return array();
	}

	function get_the_tags( int $post_id ): array|false {
		$tags = $GLOBALS['sitepilot_test_post_tags'][ $post_id ] ?? array();
		return array() === $tags ? false : $tags;
	}

	function get_taxonomy( string $taxonomy ): WP_Taxonomy|false {
		$taxonomies = array(
			'category'            => new WP_Taxonomy( 'category', true, true ),
			'post_tag'            => new WP_Taxonomy( 'post_tag' ),
			'wp_pattern_category' => new WP_Taxonomy( 'wp_pattern_category', false ),
		);
		return $taxonomies[ $taxonomy ] ?? false;
	}

	/** Terms from $GLOBALS['sitepilot_test_terms'], filtered as get_terms() would. */
	function sitepilot_test_matching_terms( array $args ): array {
		$terms = $GLOBALS['sitepilot_test_terms'][ $args['taxonomy'] ] ?? array();
		return array_values(
			array_filter(
				$terms,
				static fn ( WP_Term $term ): bool => ( ! isset( $args['search'] ) || false !== stripos( $term->name, $args['search'] ) )
					&& ( ! isset( $args['parent'] ) || $term->parent === $args['parent'] )
			)
		);
	}

	function get_terms( array $args ): array {
		return array_slice( sitepilot_test_matching_terms( $args ), 0, $args['number'] ?? null );
	}

	function wp_count_terms( array $args ): int {
		return count( sitepilot_test_matching_terms( $args ) );
	}

	function is_object_in_taxonomy( string $object_type, string $taxonomy ): bool {
		return 'post' === $object_type && in_array( $taxonomy, array( 'category', 'post_tag' ), true );
	}

	function get_term( int $term_id, string $taxonomy = '' ): ?WP_Term {
		foreach ( $GLOBALS['sitepilot_test_terms'][ $taxonomy ] ?? array() as $term ) {
			if ( $term->term_id === $term_id ) {
				return $term;
			}
		}
		return null;
	}

	function get_term_by( string $field, string $value, string $taxonomy ): WP_Term|false {
		foreach ( $GLOBALS['sitepilot_test_terms'][ $taxonomy ] ?? array() as $term ) {
			if ( 'name' === $field && 0 === strcasecmp( $term->name, $value ) ) {
				return $term;
			}
		}
		return false;
	}

	function wp_insert_term( string $name, string $taxonomy ): array|WP_Error {
		$existing = get_term_by( 'name', $name, $taxonomy );
		if ( $existing instanceof WP_Term ) {
			return new WP_Error( 'term_exists', 'A term with that name exists.', $existing->term_id );
		}
		$id = 100 + count( $GLOBALS['sitepilot_test_terms'][ $taxonomy ] ?? array() ) + count( $GLOBALS['sitepilot_test_terms'] );
		$GLOBALS['sitepilot_test_terms'][ $taxonomy ][] = new WP_Term( $id, sanitize_key( $name ), $name );
		return array( 'term_id' => $id, 'term_taxonomy_id' => $id );
	}

	/** Assignments live in $GLOBALS['sitepilot_test_object_terms'][ $post_id ][ $taxonomy ] as term IDs. */
	function wp_get_object_terms( int $post_id, string $taxonomy ): array {
		$ids = $GLOBALS['sitepilot_test_object_terms'][ $post_id ][ $taxonomy ] ?? array();
		return array_values( array_filter( array_map( static fn ( int $id ): ?WP_Term => get_term( $id, $taxonomy ), $ids ) ) );
	}

	function wp_set_object_terms( int $post_id, array $ids, string $taxonomy, bool $append = false ): array {
		$GLOBALS['sitepilot_test_object_terms'][ $post_id ][ $taxonomy ] = $append
			? array_values( array_unique( array_merge( $GLOBALS['sitepilot_test_object_terms'][ $post_id ][ $taxonomy ] ?? array(), $ids ) ) )
			: array_values( $ids );
		return $ids;
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
		unset( $single );
		return (string) ( $GLOBALS['sitepilot_test_post_meta'][ $post_id ][ $key ] ?? '' );
	}

	function update_post_meta( int $post_id, string $key, string $value ): void {
		$GLOBALS['sitepilot_test_post_meta'][ $post_id ][ $key ] = $value;
		$GLOBALS['sitepilot_test_attachment_meta'][ $post_id ][ $key ] = $value;
	}

	function metadata_exists( string $type, int $object_id, string $key ): bool {
		unset( $type );
		return isset( $GLOBALS['sitepilot_test_post_meta'][ $object_id ][ $key ] );
	}

	function delete_post_meta( int $post_id, string $key ): bool {
		unset( $GLOBALS['sitepilot_test_post_meta'][ $post_id ][ $key ] );
		return true;
	}

	function esc_url_raw( string $url, ?array $protocols = null ): string {
		unset( $protocols );
		return preg_match( '#^https?://[^\s"<>]+$#i', $url ) ? $url : '';
	}

	// Yoast SEO is active in the test runtime.
	define( 'WPSEO_VERSION', '27.4' );

	function wp_basename( string $path ): string {
		return basename( $path );
	}

	function wp_upload_bits( string $name, mixed $deprecated, string $bits ): array {
		unset( $deprecated );
		$file = '/tmp/' . $name;
		$url  = 'https://example.test/wp-content/uploads/' . rawurlencode( $name );
		$GLOBALS['sitepilot_test_uploads'][] = array(
			'name'  => $name,
			'bits'  => $bits,
			'file'  => $file,
			'url'   => $url,
		);
		return array(
			'file'  => $file,
			'url'   => $url,
			'error' => false,
		);
	}

	function wp_insert_attachment( array $attachment, string $file ): int|WP_Error {
		unset( $file );
		$post_id                                    = 200 + count( $GLOBALS['sitepilot_test_uploads'] );
		$GLOBALS['sitepilot_test_posts'][ $post_id ] = new WP_Post(
			$post_id,
			(string) ( $attachment['post_title'] ?? '' ),
			'',
			''
		);
		return $post_id;
	}

	function wp_generate_attachment_metadata( int $attachment_id, string $file ): array {
		return array(
			'attachment_id' => $attachment_id,
			'file'          => $file,
		);
	}

	function wp_update_attachment_metadata( int $attachment_id, array $metadata ): void {
		$GLOBALS['sitepilot_test_attachment_meta'][ $attachment_id ]['metadata'] = $metadata;
	}

	function serialize_blocks( array $blocks ): string {
		return implode( "\n", array_map( 'serialize_block', $blocks ) );
	}

	function parse_blocks( string $content ): array {
		$blocks = array();
		if ( preg_match_all( '/<!--\s*wp:acf\/container(?:\s+(\{[\s\S]*?\}))?\s*-->([\s\S]*?)<!--\s*\/wp:acf\/container\s*-->/i', $content, $matches, PREG_SET_ORDER ) ) {
			foreach ( $matches as $match ) {
				$attrs        = isset( $match[1] ) && '' !== trim( $match[1] ) ? json_decode( $match[1], true ) : array();
				$inner_blocks = parse_blocks( (string) ( $match[2] ?? '' ) );
				$blocks[]     = array(
					'blockName'    => 'acf/container',
					'attrs'        => is_array( $attrs ) ? $attrs : array(),
					'innerBlocks'  => $inner_blocks,
					'innerHTML'    => '',
					'innerContent' => array_fill( 0, count( $inner_blocks ), null ),
				);
			}
			return $blocks;
		}

		if ( preg_match_all( '/<!--\s*wp:(paragraph|heading)(?:\s+(\{[\s\S]*?\}))?\s*-->([\s\S]*?)<!--\s*\/wp:\1\s*-->/i', $content, $matches, PREG_SET_ORDER ) ) {
			foreach ( $matches as $match ) {
				$attrs      = isset( $match[2] ) && '' !== trim( $match[2] ) ? json_decode( $match[2], true ) : array();
				$inner_html = trim( (string) ( $match[3] ?? '' ) );
				$blocks[]   = array(
					'blockName'    => 'core/' . (string) $match[1],
					'attrs'        => is_array( $attrs ) ? $attrs : array(),
					'innerBlocks'  => array(),
					'innerHTML'    => $inner_html,
					'innerContent' => '' !== $inner_html ? array( $inner_html ) : array(),
				);
			}
		}

		return $blocks;
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
