<?php
/**
 * Prepared, conditional Gutenberg v2 commit lifecycle.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * Stores approval-bound preparations and commits them inside an InnoDB
 * transaction. Final editor verification is intentionally outside this class.
 */
final class Commit_Service {

	private const PREPARED_PREFIX = 'sitepilot_v2_prepared_';
	private const RECEIPT_PREFIX  = 'sitepilot_v2_receipt_';
	private const BEFORE_PREFIX   = 'sitepilot_v2_before_';
	private const PREPARED_TTL    = 600;
	private const MAX_CONTENT     = 2000000;
	private const RETENTION_TTL   = 2592000;

	public static function register_hooks(): void {
		add_action( 'sitepilot_v2_cleanup_commit_records', array( self::class, 'cleanup_records' ), 10, 3 );
	}

	public static function cleanup_records( string $prepared_key, string $before_key, string $receipt_key = '' ): void {
		foreach ( array( $prepared_key, $before_key, $receipt_key ) as $key ) {
			if ( '' !== $key && ( str_starts_with( $key, self::PREPARED_PREFIX ) || str_starts_with( $key, self::BEFORE_PREFIX ) || str_starts_with( $key, self::RECEIPT_PREFIX ) ) ) {
				delete_option( $key );
			}
		}
	}

	/**
	 * @param array<string, mixed> $input Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function prepare( array $input ) {
		if ( ! Feature::enabled() ) {
			return Feature::disabled_error();
		}
		$execution_id  = self::identifier( $input['executionId'] ?? '' );
		$idempotency   = self::identifier( $input['idempotencyKey'] ?? '' );
		$candidate     = isset( $input['candidate'] ) && is_array( $input['candidate'] ) ? $input['candidate'] : array();
		$approval      = isset( $input['approval'] ) && is_array( $input['approval'] ) ? $input['approval'] : array();
		$media_mapping = isset( $input['mediaMapping'] ) && is_array( $input['mediaMapping'] ) ? $input['mediaMapping'] : array();
		$final_content = isset( $input['finalSerializedContent'] ) && is_string( $input['finalSerializedContent'] ) ? $input['finalSerializedContent'] : '';
		$final_hash    = strtolower( (string) ( $input['finalContentHash'] ?? '' ) );

		if ( 'sitepilot.prepare-commit-request/v2' !== ( $input['schemaVersion'] ?? null ) || '' === $execution_id || '' === $idempotency ) {
			return self::error( 'schema_invalid', 'Execution and idempotency identifiers are required.', 400 );
		}
		$shape_error = self::validate_candidate_and_approval( $candidate, $approval );
		if ( $shape_error instanceof \WP_Error ) {
			return $shape_error;
		}

		$site_id = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
		if ( ! hash_equals( $site_id, (string) $candidate['siteId'] ) ) {
			return self::error( 'permission_denied', 'The candidate belongs to another registered site.', 403 );
		}
		if ( strtotime( (string) $approval['expiresAt'] ) <= time() ) {
			return self::error( 'approval_expired', 'The candidate approval has expired.', 409 );
		}
		$binding_error = self::validate_approval_binding( $candidate, $approval['binding'] );
		if ( $binding_error instanceof \WP_Error ) {
			return $binding_error;
		}

		$content = $final_content;
		if ( strlen( $content ) > self::MAX_CONTENT ) {
			return self::error( 'request_too_large', 'The serialized content exceeds the v2 limit.', 413 );
		}
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $final_hash ) || ! hash_equals( $final_hash, hash( 'sha256', $content ) ) ) {
			return self::error( 'content_changed', 'The final content hash does not match its bytes.', 409 );
		}
		if ( 'valid' !== ( $candidate['validation']['outcome'] ?? null ) ) {
			return self::error( 'persisted_content_invalid', 'Only a successfully validated candidate can be prepared.', 422 );
		}
		$intent_error = self::validate_intent_policy( $candidate['intent'] );
		if ( $intent_error instanceof \WP_Error ) {
			return $intent_error;
		}
		$source_content = null;
		if ( 'create_draft' !== (string) $candidate['operation'] ) {
			$source_post    = get_post( absint( $candidate['sourceState']['postId'] ?? 0 ) );
			$source_content = $source_post instanceof \WP_Post ? (string) $source_post->post_content : '';
		}
		$content_error = self::validate_serialized_policy( $content, $source_content );
		if ( $content_error instanceof \WP_Error ) {
			return $content_error;
		}

		$media_error = self::validate_media_mapping( $candidate, $media_mapping );
		if ( $media_error instanceof \WP_Error ) {
			return $media_error;
		}

		$operation = (string) $candidate['operation'];
		$post_id   = null;
		$post_type = 'post';
		if ( 'create_draft' === $operation ) {
			$post_type = sanitize_key( (string) ( $candidate['intent']['target']['postType'] ?? '' ) );
			$empty_fields_hash = hash( 'sha256', Runtime_Fingerprint::canonical_json( array(), true ) );
			if ( ! hash_equals( $empty_fields_hash, (string) ( $candidate['sourceState']['affectedFieldsHash'] ?? '' ) ) ) {
				return self::error( 'content_changed', 'The create candidate source fields hash is invalid.', 409 );
			}
		} else {
			$post_id   = absint( $candidate['sourceState']['postId'] ?? 0 );
			$post_type = sanitize_key( (string) ( $candidate['intent']['target']['postType'] ?? '' ) );
			$source_error = self::check_source( $candidate, $post_id );
			if ( $source_error instanceof \WP_Error ) {
				return $source_error;
			}
		}

		$user_id = get_current_user_id();
		if ( ! self::can_write( $operation, $post_type, $post_id ) ) {
			return self::error( 'permission_denied', 'The registered service identity cannot write this target.', 403 );
		}

		$prepared_content = self::sanitize_content_for_save( $content );
		$prepared_policy_error = self::validate_serialized_policy( $prepared_content, $source_content );
		if ( $prepared_policy_error instanceof \WP_Error ) {
			return $prepared_policy_error;
		}

		$support = self::conditional_support();
		if ( empty( $support['supported'] ) ) {
			return new \WP_Error(
				'sitepilot_v2_conditional_commit_unsupported',
				__( 'The WordPress database tables do not support the required transactional commit.', 'sitepilot' ),
				array( 'status' => 503, 'code' => 'conditional_commit_failed', 'support' => $support )
			);
		}

		$runtime     = Runtime_Fingerprint::snapshot( $post_type, $user_id );
		if ( null === $post_id ) {
			$prepared_fields = array(
				'title'   => (string) ( $candidate['requestedPostFields']['title'] ?? '' ),
				'excerpt' => (string) ( $candidate['requestedPostFields']['excerpt'] ?? '' ),
				'status'  => 'draft',
			);
		} else {
			$source_post = get_post( $post_id );
			$prepared_fields = array(
				'title'   => (string) ( $candidate['requestedPostFields']['title'] ?? $source_post->post_title ),
				'excerpt' => (string) ( $candidate['requestedPostFields']['excerpt'] ?? $source_post->post_excerpt ),
				'status'  => (string) $source_post->post_status,
			);
		}
		// The featured image must be one of the approved, bound media items.
		$featured_media_id = 0;
		$featured_ref      = $candidate['requestedPostFields']['featuredMediaRef'] ?? null;
		if ( null !== $featured_ref ) {
			foreach ( $media_mapping as $mapping ) {
				if ( is_array( $mapping ) && (string) ( $mapping['ref'] ?? '' ) === (string) $featured_ref ) {
					$featured_media_id = absint( $mapping['attachmentId'] ?? 0 );
				}
			}
			if ( $featured_media_id < 1 || ! wp_attachment_is_image( $featured_media_id ) ) {
				return self::error( 'schema_invalid', 'The featured image is not a bound image attachment of this candidate.', 400 );
			}
		}
		$prepared_id = 'pc_' . substr( hash( 'sha256', $site_id . "\n" . $execution_id . "\n" . $idempotency . "\n" . $candidate['candidateId'] ), 0, 40 );
		$before_ref  = 'before_' . substr( hash( 'sha256', $site_id . "\n" . $execution_id . "\n" . $idempotency ), 0, 40 );
		$now         = time();
		$prepared    = array(
			'schemaVersion'            => 'sitepilot.prepared-commit/v2',
			'preparedCommitId'         => $prepared_id,
			'executionId'              => $execution_id,
			'idempotencyKey'           => $idempotency,
			'approvalId'               => (string) $approval['approvalId'],
			'candidateId'              => (string) $candidate['candidateId'],
			'siteId'                   => $site_id,
			'operation'                => $operation,
			...( null !== $post_id ? array( 'postId' => $post_id ) : array() ),
			...( isset( $candidate['sourceState']['revision'] ) ? array( 'sourceRevision' => (string) $candidate['sourceState']['revision'] ) : array() ),
			...( isset( $candidate['sourceState']['contentHash'] ) ? array( 'sourceContentHash' => (string) $candidate['sourceState']['contentHash'] ) : array() ),
			'requestedFieldsHash'      => (string) $candidate['requestedFieldsHash'],
			'affectedFieldsHash'       => (string) $candidate['sourceState']['affectedFieldsHash'],
			'capabilityFingerprint'    => (string) $candidate['capabilityFingerprint'],
			'intentHash'                => (string) $candidate['intentHash'],
			'approvedContentHash'       => (string) $candidate['contentHash'],
			'mediaManifestHash'         => (string) $candidate['mediaManifestHash'],
			'mediaMapping'              => array_values( $media_mapping ),
			'finalContent'              => $prepared_content,
			'finalContentHash'          => $final_hash,
			'serverPreparedContentHash' => hash( 'sha256', $prepared_content ),
			'serverPreparedFieldsHash' => self::fields_hash( $prepared_fields['title'], $prepared_fields['excerpt'], $prepared_fields['status'] ),
			...( $featured_media_id > 0 ? array( 'featuredMediaId' => $featured_media_id ) : array() ),
			'preparedAt'                => gmdate( 'c', $now ),
			'expiresAt'                 => gmdate( 'c', min( $now + self::PREPARED_TTL, strtotime( (string) $approval['expiresAt'] ) ) ),
		);
		$stored = array(
			'preparedCommit'          => $prepared,
			'candidate'               => $candidate,
			'approval'                => $approval,
			'serverRuntimeFingerprint' => $runtime['fingerprint'],
			'requestHash'             => hash( 'sha256', Runtime_Fingerprint::canonical_json( $input ) ),
			'beforeStateRef'          => $before_ref,
		);
		$key = self::PREPARED_PREFIX . $prepared_id;
		$old = get_option( $key, null );
		if ( is_array( $old ) ) {
			if ( ! hash_equals( (string) ( $old['requestHash'] ?? '' ), $stored['requestHash'] ) ) {
				return self::error( 'idempotency_conflict', 'The prepared commit identifiers were already used for another request.', 409 );
			}
			return array( 'schemaVersion' => 'sitepilot.prepare-commit-response/v2', 'preparedCommit' => $old['preparedCommit'], 'beforeStateRef' => $old['beforeStateRef'] );
		}
		$before_state = null;
		if ( null !== $post_id ) {
			$post = get_post( $post_id, ARRAY_A );
			$before_state = is_array( $post ) ? self::before_state( $post ) : null;
		}
		if ( ! add_option(
			self::BEFORE_PREFIX . $before_ref,
			array( 'executionId' => $execution_id, 'postId' => $post_id, 'state' => $before_state, 'operation' => $operation ),
			'',
			false
		) && ! is_array( get_option( self::BEFORE_PREFIX . $before_ref, null ) ) ) {
			return self::error( 'idempotency_conflict', 'The before-state journal could not be stored.', 409 );
		}
		if ( ! add_option( $key, $stored, '', false ) ) {
			return self::error( 'idempotency_conflict', 'The prepared commit could not be stored atomically.', 409 );
		}
		if ( function_exists( 'wp_schedule_single_event' ) ) {
			wp_schedule_single_event( $now + self::RETENTION_TTL, 'sitepilot_v2_cleanup_commit_records', array( $key, self::BEFORE_PREFIX . $before_ref, '' ) );
		}

		return array( 'schemaVersion' => 'sitepilot.prepare-commit-response/v2', 'preparedCommit' => $prepared, 'beforeStateRef' => $before_ref );
	}

	/**
	 * @param array<string, mixed> $input Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function commit( array $input ) {
		if ( ! Feature::enabled() ) {
			return Feature::disabled_error();
		}
		$prepared_id = self::identifier( $input['preparedCommitId'] ?? '' );
		$execution_id = self::identifier( $input['executionId'] ?? '' );
		$idempotency = self::identifier( $input['idempotencyKey'] ?? '' );
		if ( 'sitepilot.commit-request/v2' !== ( $input['schemaVersion'] ?? null ) || '' === $prepared_id || '' === $execution_id || '' === $idempotency ) {
			return self::error( 'schema_invalid', 'A prepared commit is required.', 400 );
		}

		global $wpdb;
		$support = self::conditional_support();
		if ( empty( $support['supported'] ) ) {
			return self::error( 'conditional_commit_failed', 'The database no longer supports transactional commits.', 503 );
		}
		$prepared_key = self::PREPARED_PREFIX . $prepared_id;
		if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
			return self::error( 'conditional_commit_failed', 'The database transaction could not be started.', 503 );
		}
		try {
			$stored_raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", $prepared_key ) );
			$stored     = is_string( $stored_raw ) ? maybe_unserialize( $stored_raw ) : null;
			if ( ! is_array( $stored ) || ! isset( $stored['preparedCommit'], $stored['candidate'] ) ) {
				throw new \RuntimeException( 'prepared_commit_missing' );
			}
			$prepared = $stored['preparedCommit'];
			if ( ! hash_equals( $execution_id, (string) $prepared['executionId'] ) || ! hash_equals( $idempotency, (string) $prepared['idempotencyKey'] ) ) {
				throw new \RuntimeException( 'prepared_commit_changed' );
			}
			$authenticated_site_id = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
			if ( ! hash_equals( $authenticated_site_id, (string) $prepared['siteId'] ) ) {
				throw new \RuntimeException( 'permission_denied' );
			}
			$receipt_key = self::RECEIPT_PREFIX . hash( 'sha256', (string) $prepared['siteId'] . "\n" . (string) $prepared['executionId'] . "\n" . (string) $prepared['idempotencyKey'] );
			$receipt_raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", $receipt_key ) );
			if ( is_string( $receipt_raw ) ) {
				$receipt = maybe_unserialize( $receipt_raw );
				if ( false === $wpdb->query( 'COMMIT' ) ) {
					throw new \RuntimeException( 'conditional_commit_failed' );
				}
				if ( is_array( $receipt ) ) {
					$receipt['disposition'] = 'reconciled';
					return $receipt;
				}
				return self::error( 'idempotency_conflict', 'Stored commit receipt is invalid.', 409 );
			}
			if ( strtotime( (string) $prepared['expiresAt'] ) <= time() || strtotime( (string) $stored['approval']['expiresAt'] ) <= time() ) {
				throw new \RuntimeException( 'approval_expired' );
			}

			$candidate = $stored['candidate'];
			$post_type = (string) ( $candidate['intent']['target']['postType'] ?? '' );
			$runtime   = Runtime_Fingerprint::snapshot( $post_type, get_current_user_id() );
			if ( ! hash_equals( (string) $stored['serverRuntimeFingerprint'], (string) $runtime['fingerprint'] ) ) {
				throw new \RuntimeException( 'runtime_changed' );
			}
			$post_id_for_permission = isset( $prepared['postId'] ) ? (int) $prepared['postId'] : null;
			if ( ! self::can_write( (string) $prepared['operation'], $post_type, $post_id_for_permission ) ) {
				throw new \RuntimeException( 'permission_denied' );
			}
			$media_error = Media_Service::verify_candidate_mappings( $candidate, (array) ( $prepared['mediaMapping'] ?? array() ) );
			if ( $media_error instanceof \WP_Error ) {
				throw new \RuntimeException( 'media_changed' );
			}

			$before_ref = (string) ( $stored['beforeStateRef'] ?? '' );
			$before_key = self::BEFORE_PREFIX . $before_ref;
			$before_raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", $before_key ) );
			$before_record = is_string( $before_raw ) ? maybe_unserialize( $before_raw ) : null;
			if ( ! is_array( $before_record ) || ! hash_equals( (string) $prepared['executionId'], (string) ( $before_record['executionId'] ?? '' ) ) ) {
				throw new \RuntimeException( 'conditional_commit_failed' );
			}
			if ( 'create_draft' === $prepared['operation'] ) {
				$post_id = self::create_draft( $candidate, (string) $prepared['finalContent'] );
			} else {
				$post_id = (int) $prepared['postId'];
				$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $post_id ), ARRAY_A );
				if ( ! is_array( $row ) ) {
					throw new \RuntimeException( 'stale_source' );
				}
				$source_error = self::check_locked_source( $candidate, $row );
				if ( $source_error !== '' ) {
					throw new \RuntimeException( $source_error );
				}
				$before_record['postId'] = $post_id;
				$before_record['state']  = self::before_state( $row );
				self::update_option_row( $before_key, $before_record );
				clean_post_cache( $post_id );
				$update = array(
					'ID'           => $post_id,
					'post_content' => (string) $prepared['finalContent'],
				);
				foreach ( array( 'title' => 'post_title', 'excerpt' => 'post_excerpt' ) as $request_key => $post_key ) {
					if ( array_key_exists( $request_key, $candidate['requestedPostFields'] ) ) {
						$update[ $post_key ] = (string) $candidate['requestedPostFields'][ $request_key ];
					}
				}
				$result = wp_update_post( wp_slash( $update ), true );
				if ( is_wp_error( $result ) || (int) $result !== $post_id ) {
					throw new \RuntimeException( 'conditional_commit_failed' );
				}
			}

			$featured_media_id = absint( $prepared['featuredMediaId'] ?? 0 );
			if ( $featured_media_id > 0 && (int) get_post_thumbnail_id( $post_id ) !== $featured_media_id ) {
				if ( ! set_post_thumbnail( $post_id, $featured_media_id ) ) {
					throw new \RuntimeException( 'conditional_commit_failed' );
				}
			}

			$row_after = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->posts} WHERE ID = %d", $post_id ), ARRAY_A );
			if ( ! is_array( $row_after ) ) {
				throw new \RuntimeException( 'conditional_commit_failed' );
			}
			$before_record['postId'] = $post_id;
			$before_record['writtenState'] = array(
				'contentHash' => hash( 'sha256', (string) $row_after['post_content'] ),
				'fieldsHash'  => self::fields_hash( (string) $row_after['post_title'], (string) $row_after['post_excerpt'], (string) $row_after['post_status'] ),
				'status'      => (string) $row_after['post_status'],
				'revision'    => self::revision_identifier( $post_id, $row_after ),
				'featuredMediaId' => (int) get_post_thumbnail_id( $post_id ),
			);
			self::update_option_row( $before_key, $before_record );
			$receipt = array(
				'schemaVersion'        => 'sitepilot.commit-receipt/v2',
				'executionId'          => (string) $prepared['executionId'],
				'idempotencyKey'       => (string) $prepared['idempotencyKey'],
				'preparedCommitId'     => (string) $prepared['preparedCommitId'],
				'disposition'          => 'applied',
				'postId'               => $post_id,
				'persistedRevision'    => self::revision_identifier( $post_id, $row_after ),
				'persistedContentHash' => hash( 'sha256', (string) $row_after['post_content'] ),
				'persistedFieldsHash'  => self::fields_hash( (string) $row_after['post_title'], (string) $row_after['post_excerpt'], (string) $row_after['post_status'] ),
				'beforeStateRef'       => $before_ref,
				'committedAt'          => gmdate( 'c' ),
			);
			self::insert_option_row( $receipt_key, $receipt );
			if ( false === $wpdb->query( 'COMMIT' ) ) {
				throw new \RuntimeException( 'conditional_commit_failed' );
			}
			wp_cache_delete( $prepared_key, 'options' );
			wp_cache_delete( $before_key, 'options' );
			wp_cache_delete( $receipt_key, 'options' );
			clean_post_cache( $post_id );
			if ( function_exists( 'wp_schedule_single_event' ) ) {
				wp_schedule_single_event( time() + self::RETENTION_TTL, 'sitepilot_v2_cleanup_commit_records', array( $prepared_key, $before_key, $receipt_key ) );
			}
			return $receipt;
		} catch ( \Throwable $error ) {
			$wpdb->query( 'ROLLBACK' );
			$code = $error->getMessage();
			$status = in_array( $code, array( 'stale_source', 'runtime_changed', 'approval_expired', 'prepared_commit_changed', 'media_changed' ), true ) ? 409 : ( 'permission_denied' === $code ? 403 : 503 );
			return self::error( $code, 'The conditional commit was rejected before a verified result could be returned.', $status );
		}
	}

	/**
	 * @param array<string, mixed> $input Request body.
	 * @return array<string, mixed>|\WP_Error|null
	 */
	public static function reconcile( array $input ) {
		$site_id      = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
		$execution_id = self::identifier( $input['executionId'] ?? '' );
		$idempotency  = self::identifier( $input['idempotencyKey'] ?? '' );
		if ( 'sitepilot.reconcile-request/v2' !== ( $input['schemaVersion'] ?? null ) || ! hash_equals( $site_id, (string) ( $input['siteId'] ?? '' ) ) || '' === $execution_id || '' === $idempotency ) {
			return self::error( 'schema_invalid', 'Execution and idempotency identifiers are required.', 400 );
		}
		$key = self::RECEIPT_PREFIX . hash( 'sha256', $site_id . "\n" . $execution_id . "\n" . $idempotency );
		$value = get_option( $key, null );
		if ( is_array( $value ) ) {
			$value['disposition'] = 'reconciled';
		}
		return array( 'schemaVersion' => 'sitepilot.reconcile-response/v2', 'receipt' => is_array( $value ) ? $value : null );
	}

	/**
	 * @param array<string, mixed> $input Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function readback( array $input ) {
		$site_id = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
		$execution_id = self::identifier( $input['executionId'] ?? '' );
		if ( 'sitepilot.readback-request/v2' !== ( $input['schemaVersion'] ?? null ) || ! hash_equals( $site_id, (string) ( $input['siteId'] ?? '' ) ) || '' === $execution_id ) {
			return self::error( 'schema_invalid', 'The readback request is invalid.', 400 );
		}
		$post_id = absint( $input['postId'] ?? 0 );
		$post    = get_post( $post_id );
		if ( ! $post instanceof \WP_Post || ! current_user_can( 'edit_post', $post_id ) ) {
			return self::error( 'permission_denied', 'The persisted post cannot be read in edit context.', 403 );
		}
		return array(
			'schemaVersion' => 'sitepilot.readback/v2',
			'siteId'        => $site_id,
			'executionId'   => $execution_id,
			'postId'        => $post_id,
			'postType'      => (string) $post->post_type,
			'revision'      => self::revision_identifier( $post_id ),
			'rawContent'    => (string) $post->post_content,
			'contentHash'   => hash( 'sha256', (string) $post->post_content ),
			'fields'        => array(
				'title'   => (string) $post->post_title,
				'excerpt' => (string) $post->post_excerpt,
				'status'  => (string) $post->post_status,
			),
			'fieldsHash'    => self::fields_hash( (string) $post->post_title, (string) $post->post_excerpt, (string) $post->post_status ),
			'featuredMediaId' => (int) get_post_thumbnail_id( $post_id ),
		);
	}

	/**
	 * @param array<string, mixed> $input Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function rollback( array $input ) {
		$site_id = \SitePilot\Security\Signed_Request_Verifier::get_authenticated_site_id();
		if ( 'sitepilot.recover-request/v2' !== ( $input['schemaVersion'] ?? null ) || ! hash_equals( $site_id, (string) ( $input['siteId'] ?? '' ) ) ) {
			return self::error( 'schema_invalid', 'The recovery request is invalid.', 400 );
		}
		$before_ref    = self::identifier( $input['beforeStateRef'] ?? '' );
		$execution_id  = self::identifier( $input['executionId'] ?? '' );
		$post_id       = absint( $input['postId'] ?? 0 );
		$expected_hash = strtolower( (string) ( $input['expectedWrittenContentHash'] ?? '' ) );
		$expected_revision = (string) ( $input['expectedWrittenRevision'] ?? '' );
		$expected_fields_hash = strtolower( (string) ( $input['expectedWrittenFieldsHash'] ?? '' ) );
		if ( $post_id < 1 || ! current_user_can( 'edit_post', $post_id ) ) {
			return self::error( 'permission_denied', 'The registered service identity cannot recover this target.', 403 );
		}
		$before_key    = self::BEFORE_PREFIX . $before_ref;
		$stored        = get_option( $before_key, null );
		if ( ! is_array( $stored ) || ! hash_equals( $execution_id, (string) ( $stored['executionId'] ?? '' ) ) || $post_id !== (int) ( $stored['postId'] ?? 0 ) ) {
			return self::error( 'rollback_conflict', 'The before-state reference does not match this execution.', 409 );
		}
		global $wpdb;
		if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
			return array( 'schemaVersion' => 'sitepilot.recover-response/v2', 'outcome' => 'failed', 'evidenceRef' => $before_ref );
		}
		try {
			$stored_raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s FOR UPDATE", $before_key ) );
			$stored = is_string( $stored_raw ) ? maybe_unserialize( $stored_raw ) : null;
			if ( ! is_array( $stored ) || ! hash_equals( $execution_id, (string) ( $stored['executionId'] ?? '' ) ) || $post_id !== (int) ( $stored['postId'] ?? 0 ) ) {
				$wpdb->query( 'ROLLBACK' );
				return array( 'schemaVersion' => 'sitepilot.recover-response/v2', 'outcome' => 'conflict', 'evidenceRef' => $before_ref );
			}
			$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $post_id ), ARRAY_A );
			$written = isset( $stored['writtenState'] ) && is_array( $stored['writtenState'] ) ? $stored['writtenState'] : array();
			$current_revision = is_array( $row ) ? self::revision_identifier( $post_id, $row ) : '';
			if ( ! is_array( $row )
				|| ! hash_equals( $expected_hash, hash( 'sha256', (string) $row['post_content'] ) )
				|| ! hash_equals( (string) ( $written['contentHash'] ?? '' ), hash( 'sha256', (string) $row['post_content'] ) )
				|| ! hash_equals( $expected_fields_hash, self::fields_hash( (string) $row['post_title'], (string) $row['post_excerpt'], (string) $row['post_status'] ) )
				|| ! hash_equals( (string) ( $written['fieldsHash'] ?? '' ), self::fields_hash( (string) $row['post_title'], (string) $row['post_excerpt'], (string) $row['post_status'] ) )
				|| ! hash_equals( (string) ( $written['status'] ?? '' ), (string) $row['post_status'] )
				|| ! hash_equals( $expected_revision, $current_revision )
				|| ! hash_equals( (string) ( $written['revision'] ?? '' ), $current_revision )
				|| ( array_key_exists( 'featuredMediaId', $written ) && (int) $written['featuredMediaId'] !== (int) get_post_thumbnail_id( $post_id ) )
			) {
				$wpdb->query( 'ROLLBACK' );
				return array( 'schemaVersion' => 'sitepilot.recover-response/v2', 'outcome' => 'conflict', 'evidenceRef' => $before_ref );
			}
			$before = $stored['state'];
			if ( null === $before && 'create_draft' === ( $stored['operation'] ?? '' ) ) {
				$result = wp_delete_post( $post_id, true );
				if ( ! $result || false === $wpdb->query( 'COMMIT' ) ) {
					throw new \RuntimeException( 'rollback_failed' );
				}
				return array( 'schemaVersion' => 'sitepilot.recover-response/v2', 'outcome' => 'restored', 'evidenceRef' => $before_ref );
			}
			clean_post_cache( $post_id );
			$result = wp_update_post(
				wp_slash(
					array(
						'ID'           => $post_id,
						'post_content' => (string) $before['post_content'],
						'post_title'   => (string) $before['post_title'],
						'post_excerpt' => (string) $before['post_excerpt'],
						'post_status'  => (string) $before['post_status'],
					)
				),
				true
			);
			if ( is_wp_error( $result ) || (int) $result !== $post_id ) {
				throw new \RuntimeException( 'rollback_failed' );
			}
			if ( is_array( $before ) && array_key_exists( '_thumbnail_id', $before ) ) {
				$previous_thumbnail = absint( $before['_thumbnail_id'] );
				if ( $previous_thumbnail > 0 ) {
					set_post_thumbnail( $post_id, $previous_thumbnail );
				} else {
					delete_post_thumbnail( $post_id );
				}
				if ( (int) get_post_thumbnail_id( $post_id ) !== $previous_thumbnail ) {
					throw new \RuntimeException( 'rollback_failed' );
				}
			}
			$restored_row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $post_id ), ARRAY_A );
			if ( ! is_array( $restored_row ) || ! self::row_matches_before( $restored_row, $before ) ) {
				throw new \RuntimeException( 'rollback_failed' );
			}
			if ( false === $wpdb->query( 'COMMIT' ) ) {
				throw new \RuntimeException( 'rollback_failed' );
			}
			clean_post_cache( $post_id );
			return array( 'schemaVersion' => 'sitepilot.recover-response/v2', 'outcome' => 'restored', 'evidenceRef' => $before_ref );
		} catch ( \Throwable $error ) {
			$wpdb->query( 'ROLLBACK' );
			return array( 'schemaVersion' => 'sitepilot.recover-response/v2', 'outcome' => 'failed', 'evidenceRef' => $before_ref );
		}
	}

	/** @return array<string, mixed> */
	public static function conditional_support(): array {
		global $wpdb;
		$engines = array();
		foreach ( array( 'posts' => $wpdb->posts, 'options' => $wpdb->options ) as $label => $table ) {
			$row = $wpdb->get_row( $wpdb->prepare( 'SHOW TABLE STATUS WHERE Name = %s', $table ), ARRAY_A );
			$engines[ $label ] = is_array( $row ) ? strtoupper( (string) ( $row['Engine'] ?? '' ) ) : '';
		}
		return array(
			'supported'             => 'INNODB' === $engines['posts'] && 'INNODB' === $engines['options'],
			'engines'               => $engines,
			'rowLock'               => 'SELECT_FOR_UPDATE',
			'hookSideEffectsAtomic' => false,
		);
	}

	/** @param array<string, mixed> $candidate @param array<string, mixed> $approval */
	private static function validate_candidate_and_approval( array $candidate, array $approval ): ?\WP_Error {
		$required_candidate = array( 'schemaVersion', 'candidateId', 'siteId', 'operation', 'intent', 'requestedPostFields', 'serializedContent', 'contentHash', 'intentHash', 'requestedFieldsHash', 'sourceState', 'capabilityFingerprint', 'mediaManifest', 'mediaManifestHash', 'validation' );
		foreach ( $required_candidate as $field ) {
			if ( ! array_key_exists( $field, $candidate ) ) {
				return self::error( 'schema_invalid', "Candidate field {$field} is required.", 400 );
			}
		}
		if ( 'sitepilot.compiled-candidate/v2' !== $candidate['schemaVersion'] || 'sitepilot.approval/v2' !== ( $approval['schemaVersion'] ?? null ) || ! isset( $approval['approvalId'], $approval['expiresAt'], $approval['binding'] ) || ! is_array( $approval['binding'] ) ) {
			return self::error( 'schema_invalid', 'Candidate or approval schema version is invalid.', 400 );
		}
		if ( ! in_array( $candidate['operation'], array( 'create_draft', 'replace_content', 'apply_operations' ), true ) ) {
			return self::error( 'schema_invalid', 'Candidate operation is invalid.', 400 );
		}
		if ( ! is_array( $candidate['sourceState'] ) || ! isset( $candidate['sourceState']['affectedFieldsHash'] ) ) {
			return self::error( 'schema_invalid', 'Candidate sourceState.affectedFieldsHash is required.', 400 );
		}
		$computed_hashes = array(
			'intentHash'          => hash( 'sha256', Runtime_Fingerprint::canonical_json( $candidate['intent'], true ) ),
			'requestedFieldsHash' => hash( 'sha256', Runtime_Fingerprint::canonical_json( $candidate['requestedPostFields'], true ) ),
			'mediaManifestHash'   => hash( 'sha256', Runtime_Fingerprint::canonical_json( $candidate['mediaManifest'] ) ),
			'contentHash'         => hash( 'sha256', (string) $candidate['serializedContent'] ),
		);
		foreach ( $computed_hashes as $field => $hash ) {
			if ( ! isset( $candidate[ $field ] ) || ! is_string( $candidate[ $field ] ) || ! hash_equals( $hash, $candidate[ $field ] ) ) {
				return self::error( 'content_changed', "Candidate field {$field} does not match its approved value.", 409 );
			}
		}
		return null;
	}

	/** @param array<string, mixed> $candidate @param array<string, mixed> $binding */
	private static function validate_approval_binding( array $candidate, array $binding ): ?\WP_Error {
		$expected = array(
			'candidateId'          => (string) $candidate['candidateId'],
			'siteId'               => (string) $candidate['siteId'],
			'operation'            => (string) $candidate['operation'],
			'intentHash'           => (string) $candidate['intentHash'],
			'contentHash'          => (string) $candidate['contentHash'],
			'requestedFieldsHash'  => (string) $candidate['requestedFieldsHash'],
			'affectedFieldsHash'   => (string) $candidate['sourceState']['affectedFieldsHash'],
			'capabilityFingerprint' => (string) $candidate['capabilityFingerprint'],
			'mediaManifestHash'    => (string) $candidate['mediaManifestHash'],
		);
		if ( isset( $candidate['sourceState']['contentHash'] ) ) {
			$expected['sourceContentHash'] = (string) $candidate['sourceState']['contentHash'];
		}
		if ( isset( $candidate['sourceState']['revision'] ) ) {
			$expected['sourceRevision'] = (string) $candidate['sourceState']['revision'];
		}
		foreach ( $expected as $key => $value ) {
			if ( ! isset( $binding[ $key ] ) || ! is_string( $binding[ $key ] ) || ! hash_equals( $value, $binding[ $key ] ) ) {
				return self::error( 'approval_invalid', "Approval binding field {$key} does not match the candidate.", 409 );
			}
		}
		return null;
	}

	/** @param array<string, mixed> $candidate @param array<int, mixed> $mapping */
	private static function validate_media_mapping( array $candidate, array $mapping ): ?\WP_Error {
		$manifest = array();
		foreach ( $candidate['mediaManifest'] as $entry ) {
			if ( is_array( $entry ) && isset( $entry['ref'] ) ) {
				$manifest[ (string) $entry['ref'] ] = $entry;
			}
		}
		if ( count( $mapping ) !== count( $manifest ) ) {
			return self::error( 'media_changed', 'The media mapping must cover the approved manifest exactly.', 409 );
		}
		$seen = array();
		foreach ( $mapping as $entry ) {
			if ( ! is_array( $entry ) || ! isset( $entry['ref'], $entry['approvedChecksum'], $entry['finalChecksum'], $entry['attachmentId'], $entry['url'] ) ) {
				return self::error( 'media_changed', 'A media mapping is incomplete.', 409 );
			}
			$approved = $manifest[ (string) $entry['ref'] ] ?? null;
			$ref = (string) $entry['ref'];
			if ( isset( $seen[ $ref ] ) || ! is_array( $approved ) || ! hash_equals( (string) $approved['approvedChecksum'], (string) $entry['approvedChecksum'] ) || ! hash_equals( (string) $entry['approvedChecksum'], (string) $entry['finalChecksum'] ) ) {
				return self::error( 'media_changed', 'A media mapping is not covered by the approval.', 409 );
			}
			$seen[ $ref ] = true;
		}
		return null;
	}

	/** @param array<string, mixed> $candidate */
	private static function check_source( array $candidate, int $post_id ): ?\WP_Error {
		$post = get_post( $post_id );
		if ( ! $post instanceof \WP_Post ) {
			return self::error( 'stale_source', 'The source post no longer exists.', 409 );
		}
		if ( ! hash_equals( (string) ( $candidate['sourceState']['contentHash'] ?? '' ), hash( 'sha256', (string) $post->post_content ) ) ) {
			return self::error( 'stale_source', 'The source content changed before preparation.', 409 );
		}
		$current_fields_hash = self::fields_hash( (string) $post->post_title, (string) $post->post_excerpt, (string) $post->post_status );
		if ( ! hash_equals( (string) ( $candidate['sourceState']['affectedFieldsHash'] ?? '' ), $current_fields_hash ) ) {
			return self::error( 'stale_source', 'The source post fields changed before preparation.', 409 );
		}
		$expected = $candidate['intent']['target']['expectedFields'] ?? array();
		foreach ( array( 'title' => (string) $post->post_title, 'excerpt' => (string) $post->post_excerpt ) as $key => $value ) {
			if ( isset( $expected[ $key ]['valueHash'] ) && ! hash_equals( (string) $expected[ $key ]['valueHash'], self::value_hash( $value ) ) ) {
				return self::error( 'stale_source', "The source {$key} changed before preparation.", 409 );
			}
			if ( isset( $expected[ $key ]['value'] ) && ! hash_equals( (string) $expected[ $key ]['value'], $value ) ) {
				return self::error( 'stale_source', "The source {$key} value changed before preparation.", 409 );
			}
		}
		if ( isset( $candidate['sourceState']['revision'] ) && ! hash_equals( (string) $candidate['sourceState']['revision'], self::revision_identifier( $post_id ) ) ) {
			return self::error( 'stale_source', 'The source revision changed before preparation.', 409 );
		}
		return null;
	}

	/** @param array<string, mixed> $candidate @param array<string, mixed> $row */
	private static function check_locked_source( array $candidate, array $row ): string {
		if ( ! hash_equals( (string) ( $candidate['sourceState']['contentHash'] ?? '' ), hash( 'sha256', (string) $row['post_content'] ) ) ) {
			return 'stale_source';
		}
		if ( isset( $candidate['sourceState']['revision'] ) && ! hash_equals( (string) $candidate['sourceState']['revision'], self::revision_identifier( (int) $row['ID'], $row ) ) ) {
			return 'stale_source';
		}
		if ( ! hash_equals( (string) ( $candidate['sourceState']['affectedFieldsHash'] ?? '' ), self::fields_hash( (string) $row['post_title'], (string) $row['post_excerpt'], (string) $row['post_status'] ) ) ) {
			return 'stale_source';
		}
		$expected = $candidate['intent']['target']['expectedFields'] ?? array();
		foreach ( array( 'title' => 'post_title', 'excerpt' => 'post_excerpt' ) as $key => $column ) {
			if ( isset( $expected[ $key ]['valueHash'] ) && ! hash_equals( (string) $expected[ $key ]['valueHash'], self::value_hash( (string) $row[ $column ] ) ) ) {
				return 'stale_source';
			}
		}
		return '';
	}

	private static function can_write( string $operation, string $post_type, ?int $post_id ): bool {
		if ( 'create_draft' === $operation ) {
			$object = get_post_type_object( $post_type );
			return $object && current_user_can( $object->cap->create_posts );
		}
		return null !== $post_id && current_user_can( 'edit_post', $post_id );
	}

	/** @param array<string, mixed> $intent */
	private static function validate_intent_policy( array $intent ): ?\WP_Error {
		if ( 'sitepilot.block-plan/v2' !== ( $intent['schemaVersion'] ?? null ) ) {
			return self::error( 'schema_invalid', 'The candidate intent schema is invalid.', 400 );
		}
		$allowed = Block_Policy::authorable_blocks();
		$is_update = 'create_draft' !== ( $intent['operation'] ?? 'create_draft' );
		$refs = array();
		$count = 0;
		$walk = function ( array $nodes, int $depth, ?string $parent, bool $partial = false ) use ( &$walk, &$refs, &$count, $allowed, $is_update ): ?\WP_Error {
			if ( $depth > 12 ) {
				return self::error( 'invalid_nesting', 'The intent exceeds the v2 nesting limit.', 422 );
			}
			foreach ( $nodes as $node ) {
				if ( ! is_array( $node ) ) {
					return self::error( 'schema_invalid', 'A block node is invalid.', 400 );
				}
				++$count;
				$name = (string) ( $node['name'] ?? '' );
				$ref  = (string) ( $node['ref'] ?? '' );
				if ( Block_Policy::SOURCE_BLOCK === $name ) {
					// Kept source blocks are checked byte-for-byte against the
					// source in validate_serialized_policy().
					if ( ! $is_update || ! empty( $node['children'] ) || ! isset( $node['attributes']['path'] ) || ! is_array( $node['attributes']['path'] ) ) {
						return self::error( 'schema_invalid', 'A kept source block reference is invalid.', 400 );
					}
					if ( '' === $ref || isset( $refs[ $ref ] ) ) {
						return self::error( 'schema_invalid', 'Block refs must be non-empty and unique.', 400 );
					}
					$refs[ $ref ] = true;
					continue;
				}
				if ( ! in_array( $name, $allowed, true ) ) {
					return self::error( 'unsupported_v2_block', "Block {$name} is outside the enabled v2 policy.", 422 );
				}
				if ( '' === $ref || isset( $refs[ $ref ] ) ) {
					return self::error( 'schema_invalid', 'Block refs must be non-empty and unique.', 400 );
				}
				$refs[ $ref ] = true;
				if ( Acf_Blocks::is_acf_block( $name ) ) {
					// An edited block keeps the source values it does not restate.
					$data_error = Acf_Blocks::validate_data( $name, $node['attributes']['data'] ?? array(), $partial && 1 === $depth );
					if ( null !== $data_error ) {
						return self::error( 'schema_invalid', $data_error, 422 );
					}
				}
				$children = isset( $node['children'] ) && is_array( $node['children'] ) ? $node['children'] : array();
				$required_parent = Block_Policy::required_parent( $name );
				// A null parent is an insertion into an existing source block, whose
				// name the editor bridge checks against the real source tree.
				if ( null !== $required_parent && null !== $parent && $required_parent !== $parent ) {
					return self::error( 'invalid_nesting', "Block {$name} has an invalid parent.", 422 );
				}
				$error = $walk( $children, $depth + 1, $name );
				if ( $error instanceof \WP_Error ) {
					return $error;
				}
			}
			return null;
		};
		if ( isset( $intent['blocks'] ) && is_array( $intent['blocks'] ) ) {
			$error = $walk( $intent['blocks'], 1, '#root' );
			if ( $error instanceof \WP_Error ) {
				return $error;
			}
		} elseif ( isset( $intent['operations'] ) && is_array( $intent['operations'] ) ) {
			foreach ( $intent['operations'] as $operation ) {
				$type    = (string) ( $operation['type'] ?? '' );
				$is_root = isset( $operation['parent']['path'] ) && is_array( $operation['parent']['path'] ) && array() === $operation['parent']['path'];
				if ( 'insert_blocks' === $type && isset( $operation['blocks'] ) && is_array( $operation['blocks'] ) ) {
					$error = $walk( $operation['blocks'], 1, $is_root ? '#root' : null );
				} elseif ( 'edit_block' === $type && isset( $operation['replacement'] ) && is_array( $operation['replacement'] ) ) {
					$error = $walk( array( $operation['replacement'] ), 1, null, true );
				} elseif ( in_array( $type, array( 'remove_block', 'move_block' ), true ) ) {
					$error = null;
				} else {
					return self::error( 'schema_invalid', 'A scoped operation is invalid.', 400 );
				}
				if ( $error instanceof \WP_Error ) {
					return $error;
				}
			}
		}
		return $count > 500 ? self::error( 'request_too_large', 'The intent exceeds the v2 block limit.', 413 ) : null;
	}

	/**
	 * New drafts may contain only authorable blocks. Updates may also keep
	 * source blocks v2 cannot author, but only as unchanged byte-for-byte
	 * copies, each used at most once.
	 */
	private static function validate_serialized_policy( string $content, ?string $source_content = null ): ?\WP_Error {
		if ( str_contains( $content, 'https://sitepilot.invalid/staged/' ) ) {
			return self::error( 'media_changed', 'Private staged media URLs cannot be persisted.', 409 );
		}
		$tree = Block_Policy::tokenize( $content );
		if ( '' !== trim( $content ) && empty( $tree ) ) {
			return self::error( 'invalid_block_markup', 'Prepared content did not parse into Gutenberg blocks.', 422 );
		}
		$count = 0;
		$depth_error = null;
		$walk = function ( array $nodes, int $depth ) use ( &$walk, &$count, &$depth_error ): void {
			foreach ( $nodes as $node ) {
				++$count;
				if ( $depth > 12 ) {
					$depth_error = self::error( 'invalid_nesting', 'Prepared content exceeds the v2 nesting limit.', 422 );
					return;
				}
				$walk( $node['children'], $depth + 1 );
			}
		};
		$walk( $tree, 1 );
		if ( $depth_error instanceof \WP_Error ) {
			return $depth_error;
		}
		if ( $count > 500 ) {
			return self::error( 'request_too_large', 'Prepared content exceeds the v2 block limit.', 413 );
		}
		$offending = Block_Policy::find_unpreserved_block( $content, $source_content );
		if ( null !== $offending ) {
			$name = (string) ( $offending['name'] ?? '' );
			if ( null === $source_content ) {
				$code = in_array( $name, array( '', 'core/missing', 'core/freeform', 'core/html' ), true ) ? 'fallback_block' : 'unsupported_v2_block';
				return self::error( $code, "Serialized block {$name} is not allowed in v2.", 422 );
			}
			return self::error(
				'content_changed',
				'' === $name
					? 'Classic content that v2 cannot author must be kept unchanged.'
					: "Block {$name} cannot be authored by v2 and must be kept unchanged from the source.",
				422
			);
		}
		return null;
	}

	private static function sanitize_content_for_save( string $content ): string {
		$filtered = apply_filters( 'content_save_pre', wp_slash( $content ) );
		return wp_unslash( is_string( $filtered ) ? $filtered : '' );
	}

	/** @param array<string, mixed> $candidate */
	private static function create_draft( array $candidate, string $content ): int {
		$fields = $candidate['requestedPostFields'];
		$result = wp_insert_post(
			wp_slash(
				array(
					'post_type'    => (string) $candidate['intent']['target']['postType'],
					'post_status'  => 'draft',
					'post_title'   => (string) ( $fields['title'] ?? '' ),
					'post_excerpt' => (string) ( $fields['excerpt'] ?? '' ),
					'post_content' => $content,
				)
			),
			true
		);
		if ( is_wp_error( $result ) || (int) $result < 1 ) {
			throw new \RuntimeException( 'conditional_commit_failed' );
		}
		return (int) $result;
	}

	/** @param array<string, mixed> $row @return array<string, int|string> */
	private static function before_state( array $row ): array {
		return array(
			'post_content'  => (string) $row['post_content'],
			'post_title'    => (string) $row['post_title'],
			'post_excerpt'  => (string) $row['post_excerpt'],
			'post_status'   => (string) $row['post_status'],
			'_thumbnail_id' => isset( $row['ID'] ) ? (int) get_post_thumbnail_id( (int) $row['ID'] ) : 0,
		);
	}

	/** @param array<string, mixed> $row @param array<string, mixed> $before */
	private static function row_matches_before( array $row, array $before ): bool {
		foreach ( array( 'post_content', 'post_title', 'post_excerpt', 'post_status' ) as $field ) {
			if ( ! array_key_exists( $field, $row ) || ! array_key_exists( $field, $before ) || ! hash_equals( (string) $before[ $field ], (string) $row[ $field ] ) ) {
				return false;
			}
		}
		return true;
	}

	/** @param array<string, mixed>|null $row */
	private static function revision_identifier( int $post_id, ?array $row = null ): string {
		$revisions = wp_get_post_revisions( $post_id, array( 'numberposts' => 1, 'fields' => 'ids' ) );
		if ( is_array( $revisions ) && ! empty( $revisions ) ) {
			return (string) (int) reset( $revisions );
		}
		return 'post:' . $post_id;
	}

	private static function fields_hash( string $title, string $excerpt, string $status ): string {
		return hash( 'sha256', Runtime_Fingerprint::canonical_json( array( 'excerpt' => $excerpt, 'status' => $status, 'title' => $title ), true ) );
	}

	private static function value_hash( string $value ): string {
		return hash( 'sha256', Runtime_Fingerprint::canonical_json( $value ) );
	}

	/** @param mixed $value */
	private static function identifier( $value ): string {
		$value = is_string( $value ) ? trim( $value ) : '';
		return '' !== $value && strlen( $value ) <= 200 ? $value : '';
	}

	/** @param array<string, mixed> $value */
	private static function insert_option_row( string $key, array $value ): void {
		global $wpdb;
		$result = $wpdb->insert(
			$wpdb->options,
			array( 'option_name' => $key, 'option_value' => maybe_serialize( $value ), 'autoload' => 'no' ),
			array( '%s', '%s', '%s' )
		);
		if ( false === $result ) {
			throw new \RuntimeException( 'idempotency_conflict' );
		}
	}

	/** @param array<string, mixed> $value */
	private static function update_option_row( string $key, array $value ): void {
		global $wpdb;
		$result = $wpdb->update(
			$wpdb->options,
			array( 'option_value' => maybe_serialize( $value ) ),
			array( 'option_name' => $key ),
			array( '%s' ),
			array( '%s' )
		);
		if ( false === $result ) {
			throw new \RuntimeException( 'conditional_commit_failed' );
		}
	}

	private static function error( string $code, string $message, int $status ): \WP_Error {
		return new \WP_Error( 'sitepilot_v2_' . sanitize_key( $code ), __( $message, 'sitepilot' ), array( 'status' => $status, 'code' => $code ) );
	}
}
