<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Mcp\Write_Abilities;

final class WriteAbilitiesTest extends TestCase {
	/**
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	private function create_draft( array $input ): array {
		$method = new ReflectionMethod( Write_Abilities::class, 'exec_create_draft_post' );
		$method->setAccessible( true );
		return $method->invoke( null, $input );
	}

	/**
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	private function update_post( array $input ): array {
		$method = new ReflectionMethod( Write_Abilities::class, 'exec_update_post_fields' );
		$method->setAccessible( true );
		return $method->invoke( null, $input );
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function paragraph_blocks(): array {
		return array(
			array(
				'blockName'    => 'core/paragraph',
				'attrs'        => array(),
				'innerBlocks'  => array(),
				'innerHTML'    => '<p>Hello world</p>',
				'innerContent' => array( '<p>Hello world</p>' ),
			),
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function layout_blocks(): array {
		return array(
			array(
				'blockName'    => 'core/columns',
				'attrs'        => array(),
				'innerBlocks'  => array(
					array(
						'blockName'    => 'core/column',
						'attrs'        => array( 'width' => '50%' ),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/paragraph',
								'attrs'        => array(),
								'innerBlocks'  => array(),
								'innerHTML'    => '<p>Text left</p>',
								'innerContent' => array( '<p>Text left</p>' ),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array( null ),
					),
					array(
						'blockName'    => 'core/column',
						'attrs'        => array( 'width' => '50%' ),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/image',
								'attrs'        => array(
									'id'  => 0,
									'url' => 'https://upload.wikimedia.org/example.jpg',
									'alt' => 'Example image',
								),
								'innerBlocks'  => array(),
								'innerHTML'    => '<figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Example image" /></figure>',
								'innerContent' => array( '<figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Example image" /></figure>' ),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array( null ),
					),
				),
				'innerHTML'    => '',
				'innerContent' => array( null, null ),
			),
			array(
				'blockName'    => 'core/spacer',
				'attrs'        => array( 'height' => '40px' ),
				'innerBlocks'  => array(),
				'innerHTML'    => '<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>',
				'innerContent' => array( '<div style="height:40px" aria-hidden="true" class="wp-block-spacer"></div>' ),
			),
		);
	}

	public function test_create_draft_with_paragraph_blocks_returns_serialized_preview(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Hello',
				'blocks'  => $this->paragraph_blocks(),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString( '<!-- wp:paragraph -->', $result['preview']['post_content'] );
		$this->assertStringContainsString( '<p>Hello world</p>', $result['preview']['post_content'] );
	}

	public function test_create_draft_with_nested_columns_image_and_spacer_serializes_blocks(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Layout',
				'blocks'  => $this->layout_blocks(),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringContainsString( '<!-- wp:columns -->', $content );
		$this->assertStringContainsString( '<!-- wp:image {"id":0,"url":"https://upload.wikimedia.org/example.jpg","alt":"Example image"} -->', $content );
		$this->assertStringContainsString( '<!-- wp:spacer {"height":"40px"} -->', $content );
	}

	public function test_wp_prefixed_planner_blocks_are_canonicalized_before_serialization(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Recovered Layout',
				'blocks'  => array(
					array(
						'blockName'    => 'wp:columns',
						'attrs'        => array(),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'wp:column',
								'attrs'        => array(),
								'innerBlocks'  => array(
									array(
										'blockName'    => 'wp:paragraph',
										'attrs'        => array(),
										'innerBlocks'  => array(),
										'innerHTML'    => 'This is some dummy text in the first column.',
										'innerContent' => array( 'This is some dummy text in the first column.' ),
									),
								),
								'innerHTML'    => '<p>This is some dummy text in the first column.</p>',
								'innerContent' => array( null ),
							),
							array(
								'blockName'    => 'wp:column',
								'attrs'        => array(),
								'innerBlocks'  => array(
									array(
										'blockName'    => 'wp:image',
										'attrs'        => array(
											'id'  => 0,
											'url' => 'https://upload.wikimedia.org/example.jpg',
											'alt' => 'Random placeholder image',
										),
										'innerBlocks'  => array(),
										'innerHTML'    => '<img src="https://upload.wikimedia.org/example.jpg" alt="Random placeholder image" />',
										'innerContent' => array(),
									),
								),
								'innerHTML'    => '<img src="https://upload.wikimedia.org/example.jpg" alt="Random placeholder image" />',
								'innerContent' => array( null ),
							),
						),
						'innerHTML'    => '<div class="wp-block-columns"></div>',
						'innerContent' => array( null, null ),
					),
					array(
						'blockName'    => 'wp:spacer',
						'attrs'        => array( 'height' => '20' ),
						'innerBlocks'  => array(),
						'innerHTML'    => '<div style="height:20px;"></div>',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringNotContainsString( 'wp:wp:', $content );
		$this->assertStringContainsString( '<!-- wp:columns -->', $content );
		$this->assertStringContainsString( '<div class="wp-block-columns">', $content );
		$this->assertStringContainsString( '<div class="wp-block-column">', $content );
		$this->assertStringContainsString( '<p>This is some dummy text in the first column.</p>', $content );
		$this->assertStringContainsString( '<figure class="wp-block-image"><img src="https://upload.wikimedia.org/example.jpg" alt="Random placeholder image"/></figure>', $content );
		$this->assertStringContainsString( '<!-- wp:spacer {"height":"20px"} -->', $content );
		$this->assertStringContainsString( '<div style="height:20px" aria-hidden="true" class="wp-block-spacer"></div>', $content );
	}

	public function test_update_post_with_blocks_returns_serialized_after_content(): void {
		$result = $this->update_post(
			array(
				'post_id' => 12,
				'blocks'  => $this->paragraph_blocks(),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString( '<!-- wp:paragraph -->', $result['after']['post_content'] );
		$this->assertSame( '<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->', $result['before']['post_content'] );
	}

	public function test_blocks_take_precedence_over_legacy_content(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Precedence',
				'content' => '<!-- wp:paragraph --><p>Legacy</p><!-- /wp:paragraph -->',
				'blocks'  => $this->paragraph_blocks(),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString( '<p>Hello world</p>', $result['preview']['post_content'] );
		$this->assertStringNotContainsString( 'Legacy', $result['preview']['post_content'] );
	}

	public function test_invalid_block_tree_returns_clear_error(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Invalid',
				'blocks'  => array(
					array(
						'blockName'   => 'core/paragraph',
						'attrs'       => array(),
						'innerBlocks' => array(),
						'innerHTML'   => '<p>Hello</p>',
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'invalid_blocks: blocks[0].innerContent must be an array', $result['error'] );
	}

	public function test_media_urls_must_be_https(): void {
		$blocks                              = $this->layout_blocks();
		$blocks[0]['innerBlocks'][1]['innerBlocks'][0]['attrs']['url'] = 'http://example.com/image.jpg';
		$result = $this->create_draft(
			array(
				'title'   => 'Invalid URL',
				'blocks'  => $blocks,
				'dry_run' => true,
			)
		);

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( 'must be an HTTPS URL', $result['error'] );
	}

	public function test_legacy_content_path_still_works(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Legacy',
				'content' => '<!-- wp:paragraph --><p>Legacy body</p><!-- /wp:paragraph -->',
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertSame(
			'<!-- wp:paragraph --><p>Legacy body</p><!-- /wp:paragraph -->',
			$result['preview']['post_content']
		);
	}
}
