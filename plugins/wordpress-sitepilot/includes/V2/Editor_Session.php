<?php
/**
 * Short-lived, read-only native editor sessions for the hosted worker.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

use SitePilot\Registration\Store;

/**
 * Issues one-use browser bootstraps and enforces the preparation boundary.
 */
final class Editor_Session {

	private const BOOTSTRAP_PREFIX = 'sitepilot_v2_boot_';
	private const SESSION_TTL      = 600;
	private const SESSION_KEY      = 'sitepilot_v2';
	private const SCRATCH_META     = '_sitepilot_v2_scratch_execution';
	/** @var array<string, mixed>|null */
	private static $current_session = null;
	private static bool $current_session_checked = false;

	public static function register_enforcement_hooks(): void {
		add_filter( 'rest_pre_dispatch', array( self::class, 'block_rest_mutation' ), 1, 3 );
		add_action( 'admin_init', array( self::class, 'block_admin_mutation' ), 1 );
		add_filter( 'wp_insert_post_data', array( self::class, 'block_post_write' ), 1, 4 );
		add_filter( 'wp_insert_attachment_data', array( self::class, 'block_post_write' ), 1, 4 );
		add_filter( 'pre_delete_post', array( self::class, 'block_delete' ), 1, 3 );
		add_filter( 'pre_delete_attachment', array( self::class, 'block_delete' ), 1, 3 );
		add_filter( 'pre_trash_post', array( self::class, 'block_trash' ), 1, 3 );
		add_filter( 'pre_untrash_post', array( self::class, 'block_trash' ), 1, 3 );
		add_action( 'enqueue_block_editor_assets', array( self::class, 'enqueue_bridge' ), 100 );
		add_action( 'sitepilot_v2_cleanup_scratch', array( self::class, 'cleanup_scratch' ), 10, 2 );
		add_action( 'sitepilot_v2_cleanup_bootstrap', array( self::class, 'cleanup_bootstrap' ) );
		add_action( 'shutdown', array( self::class, 'reset_request_context' ), 998 );
	}

	/**
	 * @param array<string, mixed> $input Session request.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function mint( array $input ) {
		if ( ! Feature::enabled() ) {
			return Feature::disabled_error();
		}

		$site_id      = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
		$site         = Store::get_site( $site_id );
		$execution_id = self::identifier( $input['executionId'] ?? '' );
		$context      = isset( $input['context'] ) && is_array( $input['context'] ) ? $input['context'] : array();
		$post_type    = sanitize_key( (string) ( $context['postType'] ?? '' ) );

		if ( null === $site || $execution_id === '' || ! in_array( $post_type, array( 'post', 'page' ), true ) ) {
			return self::error( 'invalid_session_request', 'The editor session request is incomplete.', 400 );
		}
		$user_id = (int) ( $site['user_id'] ?? 0 );
		$user    = $user_id > 0 ? get_user_by( 'id', $user_id ) : false;
		if ( ! $user instanceof \WP_User || ! user_can( $user, 'read' ) ) {
			return self::error( 'permission_denied', 'The registered SitePilot service identity is unavailable.', 403 );
		}

		$post_id = isset( $context['postId'] ) ? absint( $context['postId'] ) : 0;
		$scratch = false;
		if ( $post_id > 0 ) {
			$post = get_post( $post_id );
			// One code for every refusal, but a message that says which one, so
			// operators can act on it.
			if ( ! $post instanceof \WP_Post ) {
				return self::error( 'permission_denied', sprintf( 'There is no %1$s with ID %2$d on this site.', $post_type, $post_id ), 403 );
			}
			if ( $post_type !== $post->post_type ) {
				return self::error( 'permission_denied', sprintf( 'ID %1$d is a %2$s, not a %3$s. Choose the matching content type.', $post_id, $post->post_type, $post_type ), 403 );
			}
			if ( ! user_can( $user, 'edit_post', $post_id ) ) {
				return self::error( 'permission_denied', sprintf( 'The SitePilot WordPress user is not allowed to edit %1$s %2$d.', $post_type, $post_id ), 403 );
			}
		} else {
			$post_type_object = get_post_type_object( $post_type );
			if ( ! $post_type_object || ! user_can( $user, $post_type_object->cap->create_posts ) ) {
				return self::error( 'permission_denied', 'The service identity cannot create the requested draft type.', 403 );
			}
			$post_id = wp_insert_post(
				array(
					'post_type'    => $post_type,
					'post_status'  => 'auto-draft',
					'post_title'   => __( 'Auto Draft' ),
					'post_content' => '',
					'post_author'  => $user_id,
				),
				true
			);
			if ( is_wp_error( $post_id ) || (int) $post_id < 1 ) {
				$cause = is_wp_error( $post_id ) ? sanitize_key( (string) $post_id->get_error_code() ) : 'no_post_id';
				return self::error( 'editor_unavailable', sprintf( 'A private editor context could not be created (%s).', substr( $cause, 0, 100 ) ), 503 );
			}
			$post_id = (int) $post_id;
			$scratch = true;
			update_post_meta( $post_id, self::SCRATCH_META, $execution_id );
		}

		$expires = time() + self::SESSION_TTL;
		$token   = wp_generate_password( 64, false, false );
		$record  = array(
			'siteId'      => $site_id,
			'executionId' => $execution_id,
			'userId'      => $user_id,
			'postType'    => $post_type,
			'postId'      => $post_id,
			'scratch'     => $scratch,
			'expiresAt'   => $expires,
		);
		$expected_fingerprint = strtolower( (string) ( $context['expectedCapabilityFingerprint'] ?? '' ) );
		if ( preg_match( '/^[a-f0-9]{64}$/', $expected_fingerprint ) ) {
			$record['expectedCapabilityFingerprint'] = $expected_fingerprint;
		}

		if ( ! add_option( self::bootstrap_key( $token ), $record, '', false ) ) {
			if ( $scratch ) {
				self::cleanup_scratch( $post_id, $execution_id );
			}
			return self::error( 'editor_unavailable', 'A one-use editor bootstrap could not be stored.', 503 );
		}

		if ( $scratch && function_exists( 'wp_schedule_single_event' ) ) {
			wp_schedule_single_event( $expires + 60, 'sitepilot_v2_cleanup_scratch', array( $post_id, $execution_id ) );
		}
		if ( function_exists( 'wp_schedule_single_event' ) ) {
			wp_schedule_single_event( $expires + 60, 'sitepilot_v2_cleanup_bootstrap', array( self::bootstrap_key( $token ) ) );
		}

		return array(
			'schemaVersion' => 'sitepilot.editor-session/v2',
			'bootstrapToken' => $token,
			'bootstrapUrl'   => rest_url( 'sitepilot/v2/editor-bootstrap' ),
			'expiresAt'      => gmdate( 'c', $expires ),
			'context'        => array(
				'executionId' => $execution_id,
				'siteId'     => $site_id,
				'postType' => $post_type,
				'postId'   => $post_id,
			),
		);
	}

	/**
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function consume( string $token ) {
		if ( ! Feature::enabled() ) {
			return Feature::disabled_error();
		}
		if ( strlen( $token ) < 40 ) {
			return self::error( 'invalid_bootstrap', 'The editor bootstrap is invalid or expired.', 403 );
		}

		global $wpdb;
		$key    = self::bootstrap_key( $token );
		$stored = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key ) );
		if ( ! is_string( $stored ) ) {
			return self::error( 'invalid_bootstrap', 'The editor bootstrap is invalid or expired.', 403 );
		}
		$deleted = $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s", $key ) );
		wp_cache_delete( $key, 'options' );
		if ( 1 !== $deleted ) {
			return self::error( 'invalid_bootstrap', 'The editor bootstrap has already been consumed.', 403 );
		}

		$record = maybe_unserialize( $stored );
		if ( ! is_array( $record ) || (int) ( $record['expiresAt'] ?? 0 ) < time() ) {
			return self::error( 'invalid_bootstrap', 'The editor bootstrap is invalid or expired.', 403 );
		}

		$user_id = (int) $record['userId'];
		wp_set_current_user( $user_id );
		$manager    = \WP_Session_Tokens::get_instance( $user_id );
		$auth_token = $manager->create( (int) $record['expiresAt'] );
		$session    = $manager->get( $auth_token );
		if ( ! is_array( $session ) ) {
			return self::error( 'editor_unavailable', 'The native WordPress session could not be created.', 503 );
		}
		$session[ self::SESSION_KEY ] = $record;
		$manager->update( $auth_token, $session );

		add_filter( 'auth_cookie_expiration', array( self::class, 'auth_cookie_expiration' ), 999, 3 );
		wp_set_auth_cookie( $user_id, false, is_ssl(), $auth_token );
		remove_filter( 'auth_cookie_expiration', array( self::class, 'auth_cookie_expiration' ), 999 );

		return array(
			'schemaVersion' => 'sitepilot.editor-bootstrap/v2',
			'editorUrl'     => add_query_arg(
				array(
					'post'   => (int) $record['postId'],
					'action' => 'edit',
				),
				admin_url( 'post.php' )
			),
			'expiresAt'     => gmdate( 'c', (int) $record['expiresAt'] ),
		);
	}

	public static function auth_cookie_expiration(): int {
		return self::SESSION_TTL;
	}

	/**
	 * Returns SitePilot metadata from the native WP session. Removing any
	 * auxiliary browser cookie cannot escape the restriction.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function current(): ?array {
		if ( self::$current_session_checked ) {
			return self::$current_session;
		}
		self::$current_session_checked = true;
		if ( ! is_user_logged_in() || ! function_exists( 'wp_get_session_token' ) ) {
			return null;
		}
		$manager = \WP_Session_Tokens::get_instance( get_current_user_id() );
		$tokens  = array_filter( array_unique( self::request_session_tokens() ) );
		$record  = null;
		$scoped_token = '';
		foreach ( $tokens as $token ) {
			$session = $manager->get( $token );
			$metadata = is_array( $session ) ? ( $session[ self::SESSION_KEY ] ?? null ) : null;
			if ( is_array( $metadata ) ) {
				$record = $metadata;
				$scoped_token = $token;
				break;
			}
		}
		if ( ! is_array( $record ) || '' === $scoped_token ) {
			return null;
		}
		if ( (int) ( $record['expiresAt'] ?? 0 ) < time() ) {
			$manager->destroy( $scoped_token );
			wp_clear_auth_cookie();
			$record['expired'] = true;
		}
		self::$current_session = $record;
		return self::$current_session;
	}

	public static function reset_request_context(): void {
		self::$current_session = null;
		self::$current_session_checked = false;
	}

	/** @return array<int, string> */
	private static function request_session_tokens(): array {
		$tokens = array();
		$logged_in = wp_get_session_token();
		if ( is_string( $logged_in ) && '' !== $logged_in ) {
			$tokens[] = $logged_in;
		}
		foreach ( array( 'secure_auth', 'auth' ) as $scheme ) {
			$cookie = wp_parse_auth_cookie( '', $scheme );
			if ( is_array( $cookie ) && isset( $cookie['token'] ) && is_string( $cookie['token'] ) && '' !== $cookie['token'] ) {
				$tokens[] = $cookie['token'];
			}
		}
		return $tokens;
	}

	/**
	 * @param mixed            $result  Pre-dispatch result.
	 * @param \WP_REST_Server  $server  Server.
	 * @param \WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function block_rest_mutation( $result, $server, $request ) {
		unset( $server );
		$record = self::current();
		if ( null === $record ) {
			return $result;
		}
		if ( self::is_mutating_method( $request->get_method() ) ) {
			return self::error( 'sitepilot_v2_read_only', 'The SitePilot preparation session is read-only.', 403 );
		}
		$route = (string) $request->get_route();
		if ( preg_match( '#^/wp/v2/(?:posts|pages)(?:/|$)#', $route ) ) {
			if ( ! preg_match( '#^/wp/v2/(?:posts|pages)/(\d+)(?:/(?:revisions|autosaves)(?:/\d+)?)?$#', $route, $matches ) || (int) $matches[1] !== (int) $record['postId'] ) {
				return self::error( 'permission_denied', 'The SitePilot session cannot read another post context.', 403 );
			}
		}
		return $result;
	}

	public static function block_admin_mutation(): void {
		$record = self::current();
		if ( null === $record ) {
			return;
		}
		$method = (string) ( $_SERVER['REQUEST_METHOD'] ?? 'GET' );
		if ( self::is_mutating_method( $method ) ) {
			wp_die( esc_html__( 'The SitePilot preparation session is read-only.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}
		$script = basename( (string) ( $_SERVER['SCRIPT_NAME'] ?? '' ) );
		$safe_asset = in_array( $script, array( 'load-scripts.php', 'load-styles.php' ), true );
		$safe_editor = 'post.php' === $script
			&& 'edit' === (string) ( $_GET['action'] ?? '' )
			&& (int) ( $_GET['post'] ?? 0 ) === (int) $record['postId'];
		if ( ! $safe_asset && ! $safe_editor ) {
			wp_die( esc_html__( 'This SitePilot session is limited to its assigned editor context.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}
	}

	/**
	 * @param array<string, mixed> $data Post data.
	 * @return array<string, mixed>
	 */
	public static function block_post_write( array $data ): array {
		if ( self::current() !== null ) {
			wp_die( esc_html__( 'The SitePilot preparation session cannot write posts.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}
		return $data;
	}

	/** @return mixed */
	public static function block_delete( $delete ) {
		return self::current() !== null ? false : $delete;
	}

	/** @return mixed */
	public static function block_trash( $trash ) {
		return self::current() !== null ? false : $trash;
	}

	public static function enqueue_bridge(): void {
		$record = self::current();
		if ( null === $record ) {
			return;
		}
		$post_id = isset( $_GET['post'] ) ? absint( $_GET['post'] ) : 0;
		if ( $post_id !== (int) $record['postId'] ) {
			wp_die( esc_html__( 'The SitePilot editor context does not match this session.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}
		$post = get_post( $post_id );
		if ( ! $post instanceof \WP_Post || $post->post_type !== $record['postType'] ) {
			wp_die( esc_html__( 'The SitePilot editor context is unavailable.', 'sitepilot' ), '', array( 'response' => 403 ) );
		}

		$runtime = Runtime_Fingerprint::snapshot( (string) $record['postType'], get_current_user_id() );
		$user    = wp_get_current_user();
		$plugin_fingerprint = hash( 'sha256', Runtime_Fingerprint::canonical_json( array( $runtime['inputs']['activePlugins'], $runtime['inputs']['networkPlugins'], $runtime['inputs']['muPlugins'] ) ) );
		wp_enqueue_script(
			'sitepilot-v2-editor-bridge',
			plugins_url( 'assets/js/editor-bridge.js', SITEPILOT_PLUGIN_FILE ),
			array( 'wp-blocks', 'wp-data', 'wp-core-data', 'wp-rich-text' ),
			Feature::BRIDGE_VERSION,
			true
		);
		wp_add_inline_script(
			'sitepilot-v2-editor-bridge',
			'window.sitepilotV2Config = ' . wp_json_encode(
				array(
					'bridgeVersion'            => Feature::BRIDGE_VERSION,
					'siteId'                   => (string) $record['siteId'],
					'siteUrl'                  => home_url( '/' ),
					'wordpressVersion'         => (string) get_bloginfo( 'version' ),
					'userId'                   => get_current_user_id(),
					'userRoles'                => array_values( $user->roles ),
					'theme'                    => (string) $runtime['inputs']['theme']['stylesheet'],
					'pluginFingerprint'        => $plugin_fingerprint,
					'expectedCapabilityFingerprint' => (string) ( $record['expectedCapabilityFingerprint'] ?? '' ),
					'executionId'              => (string) $record['executionId'],
					'context'                  => array(
						'postId'   => $post_id,
						'postType' => (string) $post->post_type,
						'scratch'  => ! empty( $record['scratch'] ),
					),
					'serverRuntimeFingerprint' => $runtime['fingerprint'],
					'blockPolicy'              => Block_Policy::bridge_config(),
					// The SEO plugin v2 can write here, if any, and its fields.
					'seo'                      => \SitePilot\Seo\Seo_Adapter::describe(),
					'source'                   => array(
						'postId'      => $post_id,
						'postType'    => (string) $post->post_type,
						'schemaVersion' => 'sitepilot.source-snapshot/v2',
						'siteId'      => (string) $record['siteId'],
						'revision'    => self::revision_id( $post_id ),
						'rawContent'  => (string) $post->post_content,
						'contentHash' => hash( 'sha256', (string) $post->post_content ),
						'fields'      => array(
							'title'   => (string) $post->post_title,
							'excerpt' => (string) $post->post_excerpt,
							'status'  => (string) $post->post_status,
						),
						'fieldsHash'  => hash( 'sha256', Runtime_Fingerprint::canonical_json( array( 'excerpt' => (string) $post->post_excerpt, 'status' => (string) $post->post_status, 'title' => (string) $post->post_title ), true ) ),
						'blockTreeFingerprint' => hash( 'sha256', Runtime_Fingerprint::canonical_json( parse_blocks( (string) $post->post_content ) ) ),
						...self::source_seo( $post_id ),
						'publicUrl'   => self::public_url( $post ),
					),
				)
			) . ';',
			'before'
		);
	}

	/** The URL the post has, or will have once it is published. */
	private static function public_url( \WP_Post $post ): string {
		if ( 'publish' === $post->post_status ) {
			return (string) get_permalink( $post );
		}
		$published              = clone $post;
		$published->post_status = 'publish';
		if ( '' === (string) $published->post_name ) {
			$published->post_name = wp_unique_post_slug( sanitize_title( '' !== (string) $post->post_title ? (string) $post->post_title : (string) $post->ID ), (int) $post->ID, 'publish', (string) $post->post_type, (int) $post->post_parent );
		}
		return (string) get_permalink( $published );
	}

	/** @return array<string, mixed> */
	private static function source_seo( int $post_id ): array {
		$values = \SitePilot\Seo\Seo_Adapter::read( $post_id );
		return null === $values ? array() : array( 'seo' => $values );
	}

	public static function cleanup_scratch( int $post_id, string $execution_id ): void {
		$post = get_post( $post_id );
		if ( ! $post instanceof \WP_Post || 'auto-draft' !== $post->post_status || '' !== (string) $post->post_content ) {
			return;
		}
		if ( ! hash_equals( $execution_id, (string) get_post_meta( $post_id, self::SCRATCH_META, true ) ) ) {
			return;
		}
		wp_delete_post( $post_id, true );
	}

	public static function cleanup_bootstrap( string $key ): void {
		if ( str_starts_with( $key, self::BOOTSTRAP_PREFIX ) ) {
			delete_option( $key );
		}
	}

	private static function revision_id( int $post_id ): string {
		$revisions = wp_get_post_revisions( $post_id, array( 'numberposts' => 1, 'fields' => 'ids' ) );
		return is_array( $revisions ) && ! empty( $revisions ) ? (string) (int) reset( $revisions ) : 'post:' . $post_id;
	}

	private static function bootstrap_key( string $token ): string {
		return self::BOOTSTRAP_PREFIX . hash( 'sha256', $token );
	}

	/** @param mixed $value */
	private static function identifier( $value ): string {
		$value = is_string( $value ) ? trim( $value ) : '';
		return '' !== $value && strlen( $value ) <= 200 ? $value : '';
	}

	private static function is_mutating_method( string $method ): bool {
		return in_array( strtoupper( $method ), array( 'POST', 'PUT', 'PATCH', 'DELETE' ), true );
	}

	private static function error( string $code, string $message, int $status ): \WP_Error {
		return new \WP_Error( 'sitepilot_v2_' . $code, __( $message, 'sitepilot' ), array( 'status' => $status ) );
	}
}
