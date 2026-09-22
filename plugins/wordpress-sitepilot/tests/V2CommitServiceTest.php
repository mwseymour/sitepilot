<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Commit_Service;
use SitePilot\V2\Runtime_Fingerprint;

final class V2CommitServiceTest extends TestCase {

	public function test_canonical_json_matches_typescript_hash_fixture_with_empty_objects_and_unicode(): void {
		$value = array(
			'z' => 'A&B "quoted"',
			'a' => array(
				'attributes' => array(),
				'children'   => array(),
			),
		);

		$json = Runtime_Fingerprint::canonical_json( $value, true );

		$this->assertSame( '{"a":{"attributes":{},"children":[]},"z":"A&B \\"quoted\\""}', $json );
		$this->assertSame( '043c168ea173853eb59c0f3001bfef974ec404cb4750260b31bc2e3f33e309d9', hash( 'sha256', $json ) );
	}

	public function test_candidate_hash_recheck_rejects_post_field_tampering_after_approval(): void {
		$content = '<!-- wp:paragraph --><p>Café &amp; “tea” \\ path</p><!-- /wp:paragraph -->';
		$intent = array(
			'schemaVersion' => 'sitepilot.block-plan/v2',
			'planId'       => 'plan-1',
			'siteId'       => 'site-1',
			'operation'    => 'create_draft',
			'target'       => array( 'postType' => 'post' ),
			'postFields'   => array( 'title' => 'Café & tea', 'status' => 'draft' ),
			'media'        => array(),
			'blocks'       => array(
				array( 'ref' => 'p-1', 'name' => 'core/paragraph', 'attributes' => array( 'content' => 'Café &amp; “tea” \\ path' ), 'children' => array() ),
			),
		);
		$fields = array( 'title' => 'Café & tea' );
		$candidate = array(
			'schemaVersion'       => 'sitepilot.compiled-candidate/v2',
			'candidateId'        => 'candidate-1',
			'siteId'             => 'site-1',
			'operation'          => 'create_draft',
			'intent'             => $intent,
			'requestedPostFields' => $fields,
			'serializedContent'  => $content,
			'contentHash'       => hash( 'sha256', $content ),
			'intentHash'        => hash( 'sha256', Runtime_Fingerprint::canonical_json( $intent, true ) ),
			'requestedFieldsHash' => hash( 'sha256', Runtime_Fingerprint::canonical_json( $fields, true ) ),
			'sourceState'       => array( 'affectedFieldsHash' => str_repeat( '0', 64 ) ),
			'capabilityFingerprint' => str_repeat( '1', 64 ),
			'mediaManifest'     => array(),
			'mediaManifestHash' => hash( 'sha256', '[]' ),
			'validation'        => array( 'outcome' => 'valid' ),
		);
		$approval = array(
			'schemaVersion' => 'sitepilot.approval/v2',
			'approvalId'   => 'approval-1',
			'expiresAt'    => '2099-01-01T00:00:00Z',
			'binding'      => array(),
		);

		$method = new ReflectionMethod( Commit_Service::class, 'validate_candidate_and_approval' );
		$method->setAccessible( true );
		$this->assertNull( $method->invoke( null, $candidate, $approval ) );

		$candidate['requestedPostFields']['title'] = 'Changed after approval';
		$this->assertInstanceOf( WP_Error::class, $method->invoke( null, $candidate, $approval ) );
	}

	public function test_canonical_json_matches_javascript_for_unicode_line_terminators(): void {
		$json = Runtime_Fingerprint::canonical_json( array( 'text' => "line\u{2028}separator\u{2029}paragraph" ), true );

		$this->assertSame( "{\"text\":\"line\u{2028}separator\u{2029}paragraph\"}", $json );
		$this->assertSame( '645dde453053a876eaf9b24a758a052018f1e6d7c489bfa78fc7bfff1ded8097', hash( 'sha256', $json ) );
	}

	public function test_save_preparation_preserves_exact_ampersand_quote_unicode_and_backslash_bytes(): void {
		$content = '<!-- wp:paragraph --><p>Café &amp; “quoted” \\ path</p><!-- /wp:paragraph -->';
		$method = new ReflectionMethod( Commit_Service::class, 'sanitize_content_for_save' );
		$method->setAccessible( true );

		$this->assertSame( $content, $method->invoke( null, $content ) );
	}

	public function test_server_rejects_private_staged_media_url_before_commit(): void {
		$content = '<!-- wp:media-text {"mediaUrl":"https://sitepilot.invalid/staged/' . str_repeat( 'a', 64 ) . '"} --><div></div><!-- /wp:media-text -->';
		$method = new ReflectionMethod( Commit_Service::class, 'validate_serialized_policy' );
		$method->setAccessible( true );

		$error = $method->invoke( null, $content );
		$this->assertInstanceOf( WP_Error::class, $error );
		$this->assertSame( 'sitepilot_v2_media_changed', $error->get_error_message() );
	}

	public function test_server_policy_rejects_fixture_required_dynamic_block(): void {
		$intent = array(
			'schemaVersion' => 'sitepilot.block-plan/v2',
			'blocks' => array(
				array( 'ref' => 'latest', 'name' => 'core/latest-posts', 'attributes' => array( 'postsToShow' => 3 ), 'children' => array() ),
			),
		);
		$method = new ReflectionMethod( Commit_Service::class, 'validate_intent_policy' );
		$method->setAccessible( true );

		$this->assertInstanceOf( WP_Error::class, $method->invoke( null, $intent ) );
	}

	public function test_locked_option_update_accepts_zero_affected_rows(): void {
		$old_wpdb = $GLOBALS['wpdb'] ?? null;
		$GLOBALS['wpdb'] = new class() {
			public string $options = 'wp_options';
			public function update(): int {
				return 0;
			}
		};
		try {
			$method = new ReflectionMethod( Commit_Service::class, 'update_option_row' );
			$method->setAccessible( true );
			$method->invoke( null, 'locked-existing-row', array( 'same' => 'value' ) );
			$this->addToAssertionCount( 1 );
		} finally {
			$GLOBALS['wpdb'] = $old_wpdb;
		}
	}

	public function test_rollback_row_must_exactly_match_before_state(): void {
		$before = array(
			'post_content' => 'original content',
			'post_title'   => 'original title',
			'post_excerpt' => 'original excerpt',
			'post_status'  => 'draft',
		);
		$method = new ReflectionMethod( Commit_Service::class, 'row_matches_before' );
		$method->setAccessible( true );
		$this->assertTrue( $method->invoke( null, $before, $before ) );
		$filtered = $before;
		$filtered['post_content'] = 'filter changed rollback bytes';
		$this->assertFalse( $method->invoke( null, $filtered, $before ) );
	}
}
