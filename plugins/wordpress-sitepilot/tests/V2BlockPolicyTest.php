<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Block_Policy;
use SitePilot\V2\Commit_Service;

final class V2BlockPolicyTest extends TestCase {

	// Not authorable by v2, so updates must keep it byte-for-byte.
	private const COVER = '<!-- wp:social-links --><ul class="wp-block-social-links"><!-- wp:social-link {"url":"https://example.test/Hero","service":"wordpress"} /--></ul><!-- /wp:social-links -->';

	public function test_manifest_supplies_the_authorable_matrix(): void {
		$authorable = Block_Policy::authorable_blocks();
		$this->assertContains( 'core/paragraph', $authorable );
		$this->assertNotContains( 'acf/container', $authorable );
		$this->assertContains( 'acf/container', Block_Policy::fixture_required_blocks() );
		$this->assertSame( 'core/columns', Block_Policy::required_parent( 'core/column' ) );
		$this->assertNull( Block_Policy::required_parent( 'core/paragraph' ) );
	}

	public function test_tokenizer_records_exact_nested_byte_ranges(): void {
		$content = "<!-- wp:paragraph --><p>A</p><!-- /wp:paragraph -->\n\n" . self::COVER . "\n\nclassic text<!-- wp:acme/widget {\"id\":7} /-->";
		$tree    = Block_Policy::tokenize( $content );

		$this->assertSame( array( 'core/paragraph', 'core/social-links', null, 'acme/widget' ), array_column( $tree, 'name' ) );
		$cover = $tree[1];
		$this->assertSame( self::COVER, substr( $content, $cover['start'], $cover['end'] - $cover['start'] ) );
		$this->assertSame( 'core/social-link', $cover['children'][0]['name'] );
		$this->assertSame( "\n\nclassic text", substr( $content, $tree[2]['start'], $tree[2]['end'] - $tree[2]['start'] ) );
	}

	public function test_updates_may_keep_unchanged_non_authorable_blocks_only(): void {
		$source = '<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->' . self::COVER;
		$moved  = self::COVER . '<!-- wp:group --><div class="wp-block-group"><!-- wp:paragraph --><p>New</p><!-- /wp:paragraph --></div><!-- /wp:group -->';

		$this->assertNull( Block_Policy::find_unpreserved_block( $moved, $source ) );
		$this->assertSame(
			array( 'name' => 'core/social-links' ),
			Block_Policy::find_unpreserved_block( str_replace( 'Hero', 'Changed', $moved ), $source )
		);
		$this->assertSame(
			array( 'name' => 'core/social-links' ),
			Block_Policy::find_unpreserved_block( self::COVER . self::COVER, $source ),
			'A kept block cannot be duplicated.'
		);
		$this->assertSame( array( 'name' => 'core/social-links' ), Block_Policy::find_unpreserved_block( self::COVER, null ) );
	}

	public function test_commit_policy_uses_the_source_for_updates(): void {
		$method = new ReflectionMethod( Commit_Service::class, 'validate_serialized_policy' );
		$method->setAccessible( true );
		$source = '<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->' . self::COVER;

		$this->assertNull( $method->invoke( null, self::COVER, $source ) );
		$error = $method->invoke( null, str_replace( 'Hero', 'Edited', self::COVER ), $source );
		$this->assertInstanceOf( WP_Error::class, $error );
		$this->assertSame( 'sitepilot_v2_content_changed', $error->get_error_message() );
		$this->assertInstanceOf( WP_Error::class, $method->invoke( null, self::COVER ) );
	}

	public function test_intent_policy_accepts_kept_source_blocks_only_for_updates(): void {
		$method = new ReflectionMethod( Commit_Service::class, 'validate_intent_policy' );
		$method->setAccessible( true );
		$kept   = array( 'ref' => 'keep', 'name' => 'sitepilot/source-block', 'attributes' => array( 'path' => array( 1 ), 'expectedFingerprint' => str_repeat( 'a', 64 ) ), 'children' => array() );

		$this->assertNull(
			$method->invoke( null, array( 'schemaVersion' => 'sitepilot.block-plan/v2', 'operation' => 'replace_content', 'blocks' => array( $kept ) ) )
		);
		$this->assertInstanceOf(
			WP_Error::class,
			$method->invoke( null, array( 'schemaVersion' => 'sitepilot.block-plan/v2', 'operation' => 'create_draft', 'blocks' => array( $kept ) ) )
		);
		$this->assertNull(
			$method->invoke(
				null,
				array(
					'schemaVersion' => 'sitepilot.block-plan/v2',
					'operation'     => 'apply_operations',
					'operations'    => array(
						array( 'id' => 'm', 'type' => 'move_block', 'target' => array( 'path' => array( 1 ) ), 'parent' => array( 'path' => array() ), 'index' => 0 ),
						array( 'id' => 'i', 'type' => 'insert_blocks', 'parent' => array( 'path' => array( 0 ) ), 'index' => 0, 'blocks' => array( array( 'ref' => 'col', 'name' => 'core/column', 'attributes' => array(), 'children' => array() ) ) ),
					),
				)
			),
			'A column inserted into an existing block is checked against the real parent by the bridge.'
		);
		$this->assertInstanceOf(
			WP_Error::class,
			$method->invoke( null, array( 'schemaVersion' => 'sitepilot.block-plan/v2', 'operation' => 'create_draft', 'blocks' => array( array( 'ref' => 'col', 'name' => 'core/column', 'attributes' => array(), 'children' => array() ) ) ) ),
			'A column at the root is rejected.'
		);
	}
}
