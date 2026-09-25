<?php
/**
 * Durable, idempotent media binding for Gutenberg v2 candidates.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/** Binds approved library or staged media without changing global media metadata. */
final class Media_Service {

	private const OPTION_PREFIX = 'sitepilot_v2_media_';
	private const MAX_ITEMS = 20;
	private const MAX_ITEM_BYTES = 10000000;
	private const MAX_TOTAL_BYTES = 25000000;
	private const RETENTION_TTL = 2592000;
	private const ALLOWED_MIME_TYPES = array(
		'image/jpeg',
		'image/png',
		'image/gif',
		'image/webp',
		'video/mp4',
		'video/webm',
	);

	public static function register_hooks(): void {
		add_action( 'sitepilot_v2_cleanup_media_record', array( self::class, 'cleanup_record' ) );
	}

	/**
	 * Revalidates approved media bytes immediately before a post commit.
	 *
	 * @param array<string, mixed> $candidate Compiled candidate.
	 * @param array<int, mixed>    $mapping Final media mapping.
	 * @return true|\WP_Error
	 */
	public static function verify_candidate_mappings( array $candidate, array $mapping ) {
		$intents = array();
		foreach ( (array) ( $candidate['intent']['media'] ?? array() ) as $media ) {
			if ( ! is_array( $media ) || ! isset( $media['ref'], $media['source'] ) || ! is_array( $media['source'] ) ) {
				return self::error( 'media_changed', 'The approved media intent is incomplete.', 409 );
			}
			$ref = (string) $media['ref'];
			if ( isset( $intents[ $ref ] ) ) {
				return self::error( 'media_changed', 'The approved media intent is ambiguous.', 409 );
			}
			$intents[ $ref ] = $media['source'];
		}
		if ( count( $intents ) !== count( $mapping ) ) {
			return self::error( 'media_changed', 'The committed media mapping is incomplete.', 409 );
		}

		$seen = array();
		foreach ( $mapping as $entry ) {
			if ( ! is_array( $entry ) || ! isset( $entry['ref'], $entry['approvedChecksum'], $entry['finalChecksum'], $entry['attachmentId'], $entry['url'] ) ) {
				return self::error( 'media_changed', 'A committed media mapping is incomplete.', 409 );
			}
			$ref = (string) $entry['ref'];
			$source = $intents[ $ref ] ?? null;
			$checksum = is_array( $source ) ? (string) ( $source['checksum'] ?? '' ) : '';
			if ( isset( $seen[ $ref ] ) || ! is_array( $source ) || ! preg_match( '/^[a-f0-9]{64}$/', $checksum )
				|| ! hash_equals( $checksum, (string) $entry['approvedChecksum'] )
				|| ! hash_equals( $checksum, (string) $entry['finalChecksum'] )
			) {
				return self::error( 'media_changed', 'The committed media mapping differs from its approval.', 409 );
			}
			$seen[ $ref ] = true;
			if ( 'library_attachment' === ( $source['kind'] ?? '' ) ) {
				if ( (int) ( $source['attachmentId'] ?? 0 ) !== (int) $entry['attachmentId'] ) {
					return self::error( 'media_changed', 'The library attachment identity changed.', 409 );
				}
				$fresh = self::library_mapping( $ref, array( 'attachmentId' => (int) $source['attachmentId'], 'checksum' => $checksum ) );
			} elseif ( 'staged_asset' === ( $source['kind'] ?? '' ) ) {
				$fresh = self::verify_staged_mapping( $ref, $source, $entry );
			} else {
				return self::error( 'media_changed', 'The approved media source type is unsupported.', 409 );
			}
			if ( $fresh instanceof \WP_Error ) {
				return $fresh;
			}
			if ( ! hash_equals( Runtime_Fingerprint::canonical_json( $entry, true ), Runtime_Fingerprint::canonical_json( $fresh, true ) ) ) {
				return self::error( 'media_changed', 'The attachment URL or identity changed after media binding.', 409 );
			}
		}
		return true;
	}

	/**
	 * @param array<string, mixed> $input Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function bind( array $input ) {
		if ( ! Feature::enabled() ) {
			return Feature::disabled_error();
		}
		$site_id = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
		$execution_id = self::identifier( $input['executionId'] ?? '' );
		$idempotency_key = self::identifier( $input['idempotencyKey'] ?? '' );
		$items = isset( $input['items'] ) && is_array( $input['items'] ) ? array_values( $input['items'] ) : null;
		if ( 'sitepilot.media-bindings-request/v2' !== ( $input['schemaVersion'] ?? null )
			|| array_diff( array_keys( $input ), array( 'schemaVersion', 'executionId', 'idempotencyKey', 'siteId', 'items' ) )
			|| ! hash_equals( $site_id, (string) ( $input['siteId'] ?? '' ) )
			|| '' === $execution_id
			|| '' === $idempotency_key
			|| null === $items
			|| count( $items ) > self::MAX_ITEMS
		) {
			return self::error( 'schema_invalid', 'The media binding request is invalid.', 400 );
		}
		if ( ! current_user_can( 'upload_files' ) ) {
			return self::error( 'permission_denied', 'The registered service identity cannot bind media.', 403 );
		}
		$support = self::transaction_support();
		if ( empty( $support['supported'] ) ) {
			return self::error( 'conditional_commit_failed', 'Media binding requires transactional WordPress tables.', 503 );
		}

		$validated = self::validate_items( $items, $site_id, $execution_id, $idempotency_key );
		if ( $validated instanceof \WP_Error ) {
			return $validated;
		}
		$request_hash = hash( 'sha256', Runtime_Fingerprint::canonical_json( $input, true ) );
		$key = self::OPTION_PREFIX . hash( 'sha256', $site_id . "\n" . $execution_id . "\n" . $idempotency_key );
		$record = array(
			'siteId'         => $site_id,
			'executionId'     => $execution_id,
			'idempotencyKey'  => $idempotency_key,
			'requestHash'     => $request_hash,
			'state'           => empty( $validated ) ? 'complete' : 'processing',
			'createdAt'       => gmdate( 'c' ),
			'expiresAt'       => gmdate( 'c', time() + self::RETENTION_TTL ),
			'order'           => array_column( $validated, 'ref' ),
			'items'           => array(),
		);
		foreach ( $validated as $item ) {
			$record['items'][ $item['ref'] ] = array(
				'intent'        => $item['intent'],
				'mapping'       => null,
				'metadataReady' => false,
			);
		}
		if ( ! add_option( $key, $record, '', false ) ) {
			$existing = get_option( $key, null );
			if ( ! is_array( $existing ) || ! hash_equals( $request_hash, (string) ( $existing['requestHash'] ?? '' ) ) ) {
				return self::error( 'idempotency_conflict', 'The media binding idempotency key is already bound to another request.', 409 );
			}
		}
		if ( function_exists( 'wp_schedule_single_event' ) ) {
			wp_schedule_single_event( time() + self::RETENTION_TTL, 'sitepilot_v2_cleanup_media_record', array( $key ) );
		}

		foreach ( $validated as $item ) {
			$result = self::bind_item( $key, $request_hash, $item );
			if ( $result instanceof \WP_Error ) {
				return $result;
			}
		}
		$complete = get_option( $key, null );
		if ( ! is_array( $complete ) || ! hash_equals( $request_hash, (string) ( $complete['requestHash'] ?? '' ) ) ) {
			return self::error( 'conditional_commit_failed', 'The durable media journal could not be reconciled.', 503 );
		}
		$mapping = array();
		$created = array();
		foreach ( $complete['order'] as $ref ) {
			$entry = $complete['items'][ $ref ]['mapping'] ?? null;
			if ( ! is_array( $entry ) ) {
				return self::error( 'conditional_commit_failed', 'A media binding remains incomplete.', 503 );
			}
			$mapping[] = $entry;
			if ( 'staged_asset' === ( $complete['items'][ $ref ]['intent']['kind'] ?? '' ) ) {
				$created[] = (int) $entry['attachmentId'];
			}
		}
		return array(
			'schemaVersion'  => 'sitepilot.media-bindings-response/v2',
			'mapping'        => $mapping,
			'createdMediaIds' => array_values( array_unique( $created ) ),
		);
	}

	/**
	 * @param array<int, mixed> $items
	 * @return array<int, array<string, mixed>>|\WP_Error
	 */
	private static function validate_items( array $items, string $site_id, string $execution_id, string $idempotency_key ) {
		$validated = array();
		$seen_refs = array();
		$seen_bindings = array();
		$total_bytes = 0;
		$uploads = wp_upload_dir( null, false );
		if ( ! is_array( $uploads ) || ! empty( $uploads['error'] ) ) {
			return self::error( 'media_changed', 'The WordPress uploads directory is unavailable.', 503 );
		}
		$allowed = get_allowed_mime_types();
		foreach ( $items as $raw ) {
			if ( ! is_array( $raw ) ) {
				return self::error( 'schema_invalid', 'Each media item must be an object.', 400 );
			}
			$ref = self::identifier( $raw['ref'] ?? '' );
			$kind = (string) ( $raw['kind'] ?? '' );
			$checksum = strtolower( (string) ( $raw['approvedChecksum'] ?? '' ) );
			$binding_id = strtolower( (string) ( $raw['bindingId'] ?? '' ) );
			$expected_binding_id = self::binding_id( $execution_id, $ref );
			$allowed_keys = 'library_attachment' === $kind
				? array( 'ref', 'bindingId', 'approvedChecksum', 'kind', 'attachmentId' )
				: array( 'ref', 'bindingId', 'approvedChecksum', 'kind', 'stagedAssetId', 'mediaType', 'byteLength', 'fileName', 'dataBase64', 'alt', 'caption' );
			if ( '' === $ref || isset( $seen_refs[ $ref ] ) || isset( $seen_bindings[ $binding_id ] ) || array_diff( array_keys( $raw ), $allowed_keys ) || ! preg_match( '/^[a-f0-9]{64}$/', $checksum ) || ! hash_equals( $expected_binding_id, $binding_id ) || ! in_array( $kind, array( 'library_attachment', 'staged_asset' ), true ) ) {
				return self::error( 'schema_invalid', 'A media item identity or checksum is invalid.', 400 );
			}
			$seen_refs[ $ref ] = true;
			$seen_bindings[ $binding_id ] = true;
			$intent = array( 'kind' => $kind, 'checksum' => $checksum, 'bindingHash' => $binding_id );
			$item = array( 'ref' => $ref, 'binary' => null );
			if ( 'library_attachment' === $kind ) {
				$attachment_id = absint( $raw['attachmentId'] ?? 0 );
				if ( $attachment_id < 1 ) {
					return self::error( 'schema_invalid', 'A library attachment ID is required.', 400 );
				}
				$intent['attachmentId'] = $attachment_id;
			} else {
				$staged_id = self::identifier( $raw['stagedAssetId'] ?? '' );
				$media_type = strtolower( trim( (string) ( $raw['mediaType'] ?? '' ) ) );
				$file_name = isset( $raw['fileName'] ) && is_string( $raw['fileName'] ) ? sanitize_file_name( $raw['fileName'] ) : '';
				$byte_length = absint( $raw['byteLength'] ?? 0 );
				$binary = isset( $raw['dataBase64'] ) && is_string( $raw['dataBase64'] ) ? base64_decode( $raw['dataBase64'], true ) : false;
				$file_type = wp_check_filetype( $file_name, $allowed );
				$alt = $raw['alt'] ?? null;
				$caption = $raw['caption'] ?? null;
				if ( '' === $staged_id || '' === $file_name || basename( $file_name ) !== $file_name || ! preg_match( '/^[a-f0-9]{64}\.(?:jpe?g|png|webp|gif|mp4|webm)$/', $file_name ) || ! is_string( $binary )
					|| $byte_length < 1 || $byte_length > self::MAX_ITEM_BYTES || strlen( $binary ) !== $byte_length
					|| ! in_array( $media_type, self::ALLOWED_MIME_TYPES, true )
					|| $media_type !== (string) ( $file_type['type'] ?? '' )
					|| ! hash_equals( $checksum, hash( 'sha256', $binary ) )
					|| ! is_string( $alt ) || strlen( $alt ) > 2000
					|| ( null !== $caption && ( ! is_string( $caption ) || strlen( $caption ) > 200000 ) )
				) {
					return self::error( 'media_changed', 'A staged media item failed its size, type, or checksum policy.', 422 );
				}
				$total_bytes += $byte_length;
				if ( $total_bytes > self::MAX_TOTAL_BYTES ) {
					return self::error( 'request_too_large', 'The staged media request exceeds the aggregate byte limit.', 413 );
				}
				$stored_name = 'sitepilot-v2-' . substr( $binding_id, 0, 32 ) . '-' . $file_name;
				$intent += array(
					'stagedAssetId' => $staged_id,
					'mediaType'     => $media_type,
					'byteLength'    => $byte_length,
					'fileName'      => $file_name,
					'postName'      => 'sitepilot-v2-' . substr( $binding_id, 0, 48 ),
					'absoluteFile'  => trailingslashit( (string) $uploads['path'] ) . $stored_name,
					'url'           => trailingslashit( (string) $uploads['url'] ) . rawurlencode( $stored_name ),
				);
				$item['binary'] = $binary;
			}
			$item['intent'] = $intent;
			$validated[] = $item;
		}
		return $validated;
	}

	/**
	 * @param array<string, mixed> $item
	 * @return true|\WP_Error
	 */
	private static function bind_item( string $key, string $request_hash, array $item ) {
		global $wpdb;
		if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
			return self::error( 'conditional_commit_failed', 'The media transaction could not be started.', 503 );
		}
		try {
			$raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", $key ) );
			$record = is_string( $raw ) ? maybe_unserialize( $raw ) : null;
			if ( ! is_array( $record ) || ! hash_equals( $request_hash, (string) ( $record['requestHash'] ?? '' ) ) ) {
				throw new \RuntimeException( 'idempotency_conflict' );
			}
			$ref = (string) $item['ref'];
			if ( is_array( $record['items'][ $ref ]['mapping'] ?? null ) ) {
				$mapping = $record['items'][ $ref ]['mapping'];
				$metadata_ready = ! empty( $record['items'][ $ref ]['metadataReady'] );
				$intent = $record['items'][ $ref ]['intent'];
				$fresh_mapping = 'library_attachment' === $intent['kind']
					? self::library_mapping( $ref, $intent )
					: self::staged_mapping( $ref, $intent, (string) $item['binary'] );
				if ( $fresh_mapping instanceof \WP_Error || ! hash_equals( Runtime_Fingerprint::canonical_json( $mapping, true ), Runtime_Fingerprint::canonical_json( $fresh_mapping, true ) ) ) {
					throw new \RuntimeException( $fresh_mapping instanceof \WP_Error ? (string) ( $fresh_mapping->get_error_data()['code'] ?? 'media_changed' ) : 'media_changed' );
				}
				if ( false === $wpdb->query( 'COMMIT' ) ) {
					throw new \RuntimeException( 'conditional_commit_failed' );
				}
				if ( 'staged_asset' === $intent['kind'] && ! $metadata_ready ) {
					return self::finalize_staged_metadata( $key, $request_hash, $ref, $intent, (int) $mapping['attachmentId'] );
				}
				return true;
			}
			$intent = $record['items'][ $ref ]['intent'];
			if ( 'library_attachment' === $intent['kind'] ) {
				$mapping = self::library_mapping( $ref, $intent );
			} else {
				$mapping = self::staged_mapping( $ref, $intent, (string) $item['binary'] );
			}
			if ( $mapping instanceof \WP_Error ) {
				throw new \RuntimeException( (string) ( $mapping->get_error_data()['code'] ?? 'media_changed' ) );
			}
			$record['items'][ $ref ]['mapping'] = $mapping;
			$record['items'][ $ref ]['metadataReady'] = 'library_attachment' === $intent['kind'];
			$complete = true;
			foreach ( $record['items'] as $entry ) {
				if ( ! is_array( $entry['mapping'] ?? null ) ) {
					$complete = false;
					break;
				}
			}
			$record['state'] = $complete ? 'complete' : 'processing';
			self::update_option_row( $key, $record );
			if ( false === $wpdb->query( 'COMMIT' ) ) {
				throw new \RuntimeException( 'conditional_commit_failed' );
			}
			wp_cache_delete( $key, 'options' );
			clean_post_cache( (int) $mapping['attachmentId'] );
			if ( 'staged_asset' === $intent['kind'] ) {
				return self::finalize_staged_metadata( $key, $request_hash, $ref, $intent, (int) $mapping['attachmentId'] );
			}
			return true;
		} catch ( \Throwable $error ) {
			$wpdb->query( 'ROLLBACK' );
			$code = $error->getMessage();
			$status = 'idempotency_conflict' === $code ? 409 : ( 'permission_denied' === $code ? 403 : ( 'media_changed' === $code ? 422 : 503 ) );
			return self::error( $code, 'The media binding could not be completed or safely reconciled.', $status );
		}
	}

	/** @param array<string, mixed> $intent @return array<string, mixed>|\WP_Error */
	private static function library_mapping( string $ref, array $intent ) {
		$attachment_id = (int) $intent['attachmentId'];
		if ( 'attachment' !== get_post_type( $attachment_id ) || ! current_user_can( 'edit_post', $attachment_id ) ) {
			return self::error( 'permission_denied', 'The library attachment is unavailable.', 403 );
		}
		$file = get_attached_file( $attachment_id );
		$url = wp_get_attachment_url( $attachment_id );
		if ( ! is_string( $file ) || ! is_readable( $file ) || ! is_string( $url ) || ! hash_equals( (string) $intent['checksum'], (string) hash_file( 'sha256', $file ) ) ) {
			return self::error( 'media_changed', 'The library attachment checksum changed.', 409 );
		}
		return array(
			'ref'              => $ref,
			'approvedChecksum' => (string) $intent['checksum'],
			'finalChecksum'    => (string) $intent['checksum'],
			'attachmentId'     => $attachment_id,
			'url'              => $url,
		);
	}

	/** @param array<string, mixed> $intent @return array<string, mixed>|\WP_Error */
	private static function staged_mapping( string $ref, array $intent, string $binary ) {
		global $wpdb;
		$file = (string) $intent['absoluteFile'];
		if ( is_link( $file ) ) {
			return self::error( 'media_changed', 'The deterministic media path is not a regular file.', 409 );
		}
		if ( ! file_exists( $file ) ) {
			if ( ! wp_mkdir_p( dirname( $file ) ) ) {
				return self::error( 'media_changed', 'The staged media directory could not be created.', 503 );
			}
			$temp_file = tempnam( dirname( $file ), '.sitepilot-v2-' );
			$written = is_string( $temp_file ) ? file_put_contents( $temp_file, $binary, LOCK_EX ) : false;
			if ( false === $written || $written !== strlen( $binary ) || ! is_string( $temp_file ) || ! hash_equals( (string) $intent['checksum'], (string) hash_file( 'sha256', $temp_file ) ) ) {
				if ( is_string( $temp_file ) && file_exists( $temp_file ) ) {
					wp_delete_file( $temp_file );
				}
				return self::error( 'media_changed', 'The staged media bytes could not be written.', 503 );
			}
			if ( ! @rename( $temp_file, $file ) ) {
				wp_delete_file( $temp_file );
				if ( ! file_exists( $file ) ) {
					return self::error( 'media_changed', 'The staged media file could not be atomically installed.', 503 );
				}
			}
		}
		if ( ! is_readable( $file ) || ! hash_equals( (string) $intent['checksum'], (string) hash_file( 'sha256', $file ) ) ) {
			return self::error( 'media_changed', 'The staged media file conflicts with its durable identity.', 409 );
		}
		$checked = wp_check_filetype_and_ext( $file, (string) $intent['fileName'], get_allowed_mime_types() );
		$detected_mime = self::detected_mime_type( $file, (string) $intent['mediaType'] );
		if ( (string) ( $checked['type'] ?? '' ) !== (string) $intent['mediaType'] || ! self::mime_matches( (string) $intent['mediaType'], $detected_mime ) ) {
			return self::error( 'media_changed', 'The staged media bytes do not match the approved type.', 422 );
		}
		$post_name = (string) $intent['postName'];
		$ids = $wpdb->get_col( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'attachment' AND post_name = %s ORDER BY ID ASC LIMIT 2 FOR UPDATE", $post_name ) );
		if ( count( $ids ) > 1 ) {
			return self::error( 'idempotency_conflict', 'The deterministic media identity is ambiguous.', 409 );
		}
		$attachment_id = isset( $ids[0] ) ? (int) $ids[0] : 0;
		if ( $attachment_id < 1 ) {
			require_once ABSPATH . 'wp-admin/includes/image.php';
			require_once ABSPATH . 'wp-admin/includes/file.php';
			require_once ABSPATH . 'wp-admin/includes/media.php';
			$attachment_id = wp_insert_attachment(
				array(
					'post_mime_type' => (string) $intent['mediaType'],
					'post_title'     => sanitize_text_field( pathinfo( (string) $intent['fileName'], PATHINFO_FILENAME ) ),
					'post_name'      => $post_name,
					'post_status'    => 'inherit',
					'post_content'   => '',
					'meta_input'     => array(
						'_sitepilot_v2_media_binding_key' => (string) $intent['bindingHash'],
						'_sitepilot_v2_staged_asset_id'   => (string) $intent['stagedAssetId'],
						'_sitepilot_v2_media_checksum'    => (string) $intent['checksum'],
						'_sitepilot_v2_original_file'     => $file,
						'_sitepilot_v2_original_url'      => (string) $intent['url'],
					),
				),
				$file,
				0,
				true
			);
			if ( is_wp_error( $attachment_id ) || (int) $attachment_id < 1 ) {
				return self::error( 'media_changed', 'The staged media attachment could not be created.', 503 );
			}
			$attachment_id = (int) $attachment_id;
		}
		$original_file = (string) get_post_meta( $attachment_id, '_sitepilot_v2_original_file', true );
		$original_url = (string) get_post_meta( $attachment_id, '_sitepilot_v2_original_url', true );
		if ( '' === $original_file || realpath( $original_file ) !== realpath( $file )
			|| ! hash_equals( (string) $intent['bindingHash'], (string) get_post_meta( $attachment_id, '_sitepilot_v2_media_binding_key', true ) )
			|| ! hash_equals( (string) $intent['checksum'], (string) get_post_meta( $attachment_id, '_sitepilot_v2_media_checksum', true ) )
			|| ! hash_equals( (string) $intent['url'], $original_url )
			|| ! is_readable( $original_file )
			|| ! hash_equals( (string) $intent['checksum'], (string) hash_file( 'sha256', $original_file ) )
		) {
			return self::error( 'idempotency_conflict', 'The staged attachment identity does not match its durable intent.', 409 );
		}
		return array(
			'ref'              => $ref,
			'approvedChecksum' => (string) $intent['checksum'],
			'finalChecksum'    => (string) $intent['checksum'],
			'attachmentId'     => $attachment_id,
			'url'              => (string) $intent['url'],
		);
	}

	/** @param array<string, mixed> $source @param array<string, mixed> $mapping @return array<string, mixed>|\WP_Error */
	private static function verify_staged_mapping( string $ref, array $source, array $mapping ) {
		$attachment_id = (int) $mapping['attachmentId'];
		$checksum = (string) $source['checksum'];
		$original_file = (string) get_post_meta( $attachment_id, '_sitepilot_v2_original_file', true );
		$original_url = (string) get_post_meta( $attachment_id, '_sitepilot_v2_original_url', true );
		$declared_mime = (string) ( $source['mediaType'] ?? '' );
		if ( $attachment_id < 1 || 'attachment' !== get_post_type( $attachment_id ) || ! current_user_can( 'edit_post', $attachment_id )
			|| ! hash_equals( (string) ( $source['stagedAssetId'] ?? '' ), (string) get_post_meta( $attachment_id, '_sitepilot_v2_staged_asset_id', true ) )
			|| ! hash_equals( $checksum, (string) get_post_meta( $attachment_id, '_sitepilot_v2_media_checksum', true ) )
			|| ! is_readable( $original_file ) || ! hash_equals( $checksum, (string) hash_file( 'sha256', $original_file ) )
			|| ! in_array( $declared_mime, self::ALLOWED_MIME_TYPES, true )
			|| ! self::mime_matches( $declared_mime, self::detected_mime_type( $original_file, $declared_mime ) )
			|| ! hash_equals( $declared_mime, (string) get_post_mime_type( $attachment_id ) )
			|| '' === $original_url || ! hash_equals( (string) $mapping['url'], $original_url )
		) {
			return self::error( 'media_changed', 'The staged attachment bytes or durable identity changed.', 409 );
		}
		return array(
			'ref'              => $ref,
			'approvedChecksum' => $checksum,
			'finalChecksum'    => $checksum,
			'attachmentId'     => $attachment_id,
			'url'              => $original_url,
		);
	}

	/** @param array<string, mixed> $intent @return true|\WP_Error */
	private static function finalize_staged_metadata( string $key, string $request_hash, string $ref, array $intent, int $attachment_id ) {
		require_once ABSPATH . 'wp-admin/includes/image.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		$metadata = wp_generate_attachment_metadata( $attachment_id, (string) $intent['absoluteFile'] );
		if ( is_array( $metadata ) && ! empty( $metadata ) ) {
			$updated = wp_update_attachment_metadata( $attachment_id, $metadata );
			if ( ! $updated && ! is_array( wp_get_attachment_metadata( $attachment_id ) ) ) {
				return self::error( 'media_changed', 'The staged media metadata could not be saved.', 503 );
			}
		}
		global $wpdb;
		if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
			return self::error( 'conditional_commit_failed', 'The media metadata journal could not be started.', 503 );
		}
		try {
			$raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", $key ) );
			$record = is_string( $raw ) ? maybe_unserialize( $raw ) : null;
			if ( ! is_array( $record ) || ! hash_equals( $request_hash, (string) ( $record['requestHash'] ?? '' ) ) || $attachment_id !== (int) ( $record['items'][ $ref ]['mapping']['attachmentId'] ?? 0 ) ) {
				throw new \RuntimeException( 'idempotency_conflict' );
			}
			$record['items'][ $ref ]['metadataReady'] = true;
			self::update_option_row( $key, $record );
			if ( false === $wpdb->query( 'COMMIT' ) ) {
				throw new \RuntimeException( 'conditional_commit_failed' );
			}
			wp_cache_delete( $key, 'options' );
			return true;
		} catch ( \Throwable $error ) {
			$wpdb->query( 'ROLLBACK' );
			return self::error( $error->getMessage(), 'The media metadata journal could not be completed.', 503 );
		}
	}

	private static function detected_mime_type( string $file, string $declared ): string {
		if ( str_starts_with( $declared, 'image/' ) ) {
			$image = @getimagesize( $file );
			return is_array( $image ) ? (string) ( $image['mime'] ?? '' ) : '';
		}
		$finfo = function_exists( 'finfo_open' ) ? finfo_open( FILEINFO_MIME_TYPE ) : false;
		if ( false === $finfo ) {
			return '';
		}
		$mime = finfo_file( $finfo, $file );
		finfo_close( $finfo );
		return is_string( $mime ) ? strtolower( $mime ) : '';
	}

	private static function mime_matches( string $declared, string $detected ): bool {
		if ( ! in_array( $declared, self::ALLOWED_MIME_TYPES, true ) ) {
			return false;
		}
		// finfo reports some valid MP4 files by their ISO base-media family.
		$aliases = array(
			'video/mp4' => array( 'video/mp4', 'video/iso.segment', 'application/mp4' ),
		);
		return in_array( $detected, $aliases[ $declared ] ?? array( $declared ), true );
	}

	private static function binding_id( string $execution_id, string $ref ): string {
		return hash( 'sha256', $execution_id . "\0" . $ref );
	}

	/** @return array<string, mixed> */
	private static function transaction_support(): array {
		global $wpdb;
		$engines = array();
		foreach ( array( 'posts' => $wpdb->posts, 'postmeta' => $wpdb->postmeta, 'options' => $wpdb->options ) as $label => $table ) {
			$row = $wpdb->get_row( $wpdb->prepare( 'SHOW TABLE STATUS WHERE Name = %s', $table ), ARRAY_A );
			$engines[ $label ] = is_array( $row ) ? strtoupper( (string) ( $row['Engine'] ?? '' ) ) : '';
		}
		return array( 'supported' => count( array_filter( $engines, static fn ( $engine ) => 'INNODB' === $engine ) ) === 3, 'engines' => $engines );
	}

	/** @param array<string, mixed> $value */
	private static function update_option_row( string $key, array $value ): void {
		global $wpdb;
		$result = $wpdb->update( $wpdb->options, array( 'option_value' => maybe_serialize( $value ) ), array( 'option_name' => $key ), array( '%s' ), array( '%s' ) );
		if ( false === $result ) {
			throw new \RuntimeException( 'conditional_commit_failed' );
		}
	}

	public static function cleanup_record( string $key ): void {
		if ( str_starts_with( $key, self::OPTION_PREFIX ) ) {
			delete_option( $key );
		}
	}

	/** @param mixed $value */
	private static function identifier( $value ): string {
		$value = is_string( $value ) ? trim( $value ) : '';
		return '' !== $value && strlen( $value ) <= 200 ? $value : '';
	}

	private static function error( string $code, string $message, int $status ): \WP_Error {
		return new \WP_Error( 'sitepilot_v2_' . $code, __( $message, 'sitepilot' ), array( 'status' => $status, 'code' => $code ) );
	}
}
