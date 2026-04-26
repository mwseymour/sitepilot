<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Mcp\Write_Abilities;

final class WriteAbilitiesTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_post_meta'] = array();
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post( 12, 'Existing title', '<!-- wp:paragraph --><p>Old</p><!-- /wp:paragraph -->', 'Old excerpt' );
	}

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
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	private function upload_media( array $input ): array {
		$method = new ReflectionMethod( Write_Abilities::class, 'exec_upload_media_asset' );
		$method->setAccessible( true );
		return $method->invoke( null, $input );
	}

	/**
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	private function seo_meta( array $input ): array {
		$method = new ReflectionMethod( Write_Abilities::class, 'exec_set_post_seo_meta' );
		$method->setAccessible( true );
		return $method->invoke( null, $input );
	}

	/**
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	private function featured_image( array $input ): array {
		$method = new ReflectionMethod( Write_Abilities::class, 'exec_set_post_featured_image' );
		$method->setAccessible( true );
		return $method->invoke( null, $input );
	}

	/**
	 * @return array<string, mixed>
	 */
	private function parsed_blocks_schema(): array {
		$method = new ReflectionMethod( Write_Abilities::class, 'parsed_blocks_schema' );
		$method->setAccessible( true );
		return $method->invoke( null );
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

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function four_column_heading_blocks(): array {
		$columns = array();
		foreach ( array( '1', '2', '3', '4' ) as $label ) {
			$columns[] = array(
				'blockName'    => 'core/column',
				'attrs'        => array(),
				'innerBlocks'  => array(
					array(
						'blockName'    => 'core/heading',
						'attrs'        => array( 'level' => 2 ),
						'innerBlocks'  => array(),
						'innerHTML'    => '<h2>' . $label . '</h2>',
						'innerContent' => array( '<h2>' . $label . '</h2>' ),
					),
				),
				'innerHTML'    => '<div class="wp-block-column"></div>',
				'innerContent' => array( '<div class="wp-block-column">', null, '</div>' ),
			);
		}

		return array(
			array(
				'blockName'    => 'core/columns',
				'attrs'        => array(),
				'innerBlocks'  => $columns,
				'innerHTML'    => '<div class="wp-block-columns"></div>',
				'innerContent' => array(
					'<div class="wp-block-columns">',
					null,
					"\n\n",
					null,
					"\n\n",
					null,
					"\n\n",
					null,
					'</div>',
				),
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

	public function test_create_draft_rejects_unsupported_core_blocks(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Unsupported Cover',
				'blocks'  => array(
					array(
						'blockName'    => 'core/gallery',
						'attrs'        => array(
							'url' => 'https://upload.wikimedia.org/example.jpg',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '<figure class="wp-block-gallery"></figure>',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( 'unsupported block "core/gallery"', $result['error'] );
	}

	public function test_update_post_rejects_escaped_serialized_gutenberg_markup_inside_paragraph_blocks(): void {
		$result = $this->update_post(
			array(
				'post_id' => 12,
				'blocks'  => array(
					array(
						'blockName'    => 'core/paragraph',
						'attrs'        => array(),
						'innerBlocks'  => array(),
						'innerHTML'    => '<p>Lorem ipsum dolor sit amet.&lt;!-- /wp:paragraph --&gt;
&lt;!-- wp:paragraph --&gt;Sed do eiusmod tempor incididunt ut labore.&lt;!-- /wp:paragraph --&gt;
&lt;!-- wp:heading --&gt;New heading!&lt;!-- /wp:heading --&gt;</p>',
						'innerContent' => array(
							'<p>Lorem ipsum dolor sit amet.&lt;!-- /wp:paragraph --&gt;
&lt;!-- wp:paragraph --&gt;Sed do eiusmod tempor incididunt ut labore.&lt;!-- /wp:paragraph --&gt;
&lt;!-- wp:heading --&gt;New heading!&lt;!-- /wp:heading --&gt;</p>',
						),
					),
				),
			)
		);

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( 'invalid_blocks:', $result['error'] );
		$this->assertStringContainsString( 'serialized block markup', $result['error'] );
	}

	public function test_blocked_cover_and_read_more_advise_manual_editor_fallback(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Blocked Blocks',
				'blocks'  => array(
					array(
						'blockName'    => 'core/cover',
						'attrs'        => array(
							'url' => 'https://example.com/hero.jpg',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( 'unsupported block "core/cover"', $result['error'] );
		$this->assertStringContainsString( 'Add it manually in the WordPress post editor for now.', $result['error'] );
	}

	public function test_heading_level_is_respected_during_serialization(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Heading Level',
				'blocks'  => array(
					array(
						'blockName'    => 'core/heading',
						'attrs'        => array( 'level' => 1 ),
						'innerBlocks'  => array(),
						'innerHTML'    => 'Hero Title',
						'innerContent' => array( 'Hero Title' ),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString( '<h1 class="wp-block-heading">Hero Title</h1>', $result['preview']['post_content'] );
	}

	public function test_create_draft_with_standalone_batch_one_blocks_serializes(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Standalone Batch',
				'blocks'  => array(
					array(
						'blockName'    => 'core/quote',
						'attrs'        => array(),
						'innerBlocks'  => array(),
						'innerHTML'    => 'Quoted line',
						'innerContent' => array( 'Quoted line' ),
					),
					array(
						'blockName'    => 'core/code',
						'attrs'        => array(),
						'innerBlocks'  => array(),
						'innerHTML'    => 'const x = 1;',
						'innerContent' => array( 'const x = 1;' ),
					),
					array(
						'blockName'    => 'core/separator',
						'attrs'        => array(),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringContainsString( '<blockquote class="wp-block-quote"><p>Quoted line</p></blockquote>', $content );
		$this->assertStringContainsString( '<pre class="wp-block-code"><code>const x = 1;</code></pre>', $content );
		$this->assertStringContainsString( '<hr class="wp-block-separator has-alpha-channel-opacity"/>', $content );
	}

	public function test_create_draft_with_list_blocks_serializes(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'List Batch',
				'blocks'  => array(
					array(
						'blockName'    => 'core/list',
						'attrs'        => array(
							'ordered' => true,
							'start'   => 3,
						),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/list-item',
								'attrs'        => array(),
								'innerBlocks'  => array(),
								'innerHTML'    => 'First item',
								'innerContent' => array( 'First item' ),
							),
							array(
								'blockName'    => 'core/list-item',
								'attrs'        => array(),
								'innerBlocks'  => array(),
								'innerHTML'    => '<li class="custom">Second item</li>',
								'innerContent' => array( '<li class="custom">Second item</li>' ),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringContainsString( '<!-- wp:list {"ordered":true,"start":3} -->', $content );
		$this->assertStringContainsString( '<ol class="wp-block-list" start="3">', $content );
		$this->assertStringContainsString( '<!-- wp:list-item --><li>First item</li><!-- /wp:list-item -->', $content );
		$this->assertStringContainsString( '<!-- wp:list-item --><li>Second item</li><!-- /wp:list-item -->', $content );
	}

	public function test_create_draft_with_buttons_group_and_details_serializes(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Next Batches',
				'blocks'  => array(
					array(
						'blockName'    => 'core/buttons',
						'attrs'        => array(),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/button',
								'attrs'        => array(
									'url'  => 'https://example.com',
									'text' => 'Read More',
								),
								'innerBlocks'  => array(),
								'innerHTML'    => '',
								'innerContent' => array(),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
					array(
						'blockName'    => 'core/group',
						'attrs'        => array(
							'tagName' => 'section',
						),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/paragraph',
								'attrs'        => array(),
								'innerBlocks'  => array(),
								'innerHTML'    => 'Inside group',
								'innerContent' => array( 'Inside group' ),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
					array(
						'blockName'    => 'core/details',
						'attrs'        => array(
							'summary'     => 'FAQ',
							'showContent' => true,
						),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/paragraph',
								'attrs'        => array(),
								'innerBlocks'  => array(),
								'innerHTML'    => 'Answer',
								'innerContent' => array( 'Answer' ),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringContainsString( '<!-- wp:buttons -->', $content );
		$this->assertStringContainsString( '<!-- wp:button {"url":"https://example.com","text":"Read More"} --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://example.com">Read More</a></div><!-- /wp:button -->', $content );
		$this->assertStringContainsString( '<!-- wp:group {"tagName":"section"} --><section class="wp-block-group">', $content );
		$this->assertStringContainsString( '<!-- wp:details {"summary":"FAQ","showContent":true} --><details class="wp-block-details" open><summary>FAQ</summary>', $content );
	}

	public function test_create_draft_with_pullquote_table_and_media_text_serializes(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Advanced Batch',
				'blocks'  => array(
					array(
						'blockName'    => 'core/pullquote',
						'attrs'        => array(
							'value'    => 'Big quote',
							'citation' => 'Author',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => 'Big quote',
						'innerContent' => array( 'Big quote' ),
					),
					array(
						'blockName'    => 'core/table',
						'attrs'        => array(
							'caption' => 'Pricing',
							'body'    => array(
								array(
									'cells' => array(
										array(
											'tag'     => 'th',
											'content' => 'Plan',
											'scope'   => 'col',
										),
										array(
											'tag'     => 'th',
											'content' => 'Price',
											'scope'   => 'col',
										),
									),
								),
								array(
									'cells' => array(
										array(
											'tag'     => 'td',
											'content' => 'Starter',
										),
										array(
											'tag'     => 'td',
											'content' => '$10',
										),
									),
								),
							),
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
					array(
						'blockName'    => 'core/media-text',
						'attrs'        => array(
							'mediaType'         => 'image',
							'mediaUrl'          => 'https://example.com/photo.jpg',
							'mediaAlt'          => 'Photo',
							'mediaPosition'     => 'right',
							'mediaWidth'        => 40,
							'isStackedOnMobile' => true,
						),
						'innerBlocks'  => array(
							array(
								'blockName'    => 'core/paragraph',
								'attrs'        => array(),
								'innerBlocks'  => array(),
								'innerHTML'    => 'Media text body',
								'innerContent' => array( 'Media text body' ),
							),
						),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringContainsString( '<!-- wp:pullquote {"value":"Big quote","citation":"Author"} --><figure class="wp-block-pullquote"><blockquote><p>Big quote</p><cite>Author</cite></blockquote></figure><!-- /wp:pullquote -->', $content );
		$this->assertStringContainsString( '<!-- wp:table {"caption":"Pricing","body":[{"cells":[{"tag":"th","content":"Plan","scope":"col"},{"tag":"th","content":"Price","scope":"col"}]},{"cells":[{"tag":"td","content":"Starter"},{"tag":"td","content":"$10"}]}]} --><figure class="wp-block-table"><table class="has-fixed-layout">', $content );
		$this->assertStringContainsString( '<figcaption class="wp-element-caption">Pricing</figcaption>', $content );
		$this->assertStringContainsString( '<!-- wp:media-text {"mediaType":"image","mediaUrl":"https://example.com/photo.jpg","mediaAlt":"Photo","mediaPosition":"right","mediaWidth":40,"isStackedOnMobile":true} --><div class="wp-block-media-text has-media-on-the-right is-stacked-on-mobile" style="grid-template-columns:auto 40%"><div class="wp-block-media-text__content">', $content );
		$this->assertStringContainsString( '<figure class="wp-block-media-text__media"><img src="https://example.com/photo.jpg" alt="Photo"/></figure></div><!-- /wp:media-text -->', $content );
	}

	public function test_create_draft_with_requested_more_file_html_shortcode_and_video_blocks_serializes(): void {
		$result = $this->create_draft(
			array(
				'title'   => 'Requested Blocks',
				'blocks'  => array(
					array(
						'blockName'    => 'core/more',
						'attrs'        => array(
							'customText' => 'Continue',
							'noTeaser'   => true,
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
					array(
						'blockName'    => 'core/html',
						'attrs'        => array(
							'content' => '<div>Raw HTML</div>',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '<div>Raw HTML</div>',
						'innerContent' => array( '<div>Raw HTML</div>' ),
					),
					array(
						'blockName'    => 'core/shortcode',
						'attrs'        => array(
							'text' => '[gallery ids="1,2"]',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
					array(
						'blockName'    => 'core/file',
						'attrs'        => array(
							'href'               => 'https://example.com/file.pdf',
							'fileName'           => 'Brochure.pdf',
							'fileId'             => 'file-link',
							'downloadButtonText' => 'Download file',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
					array(
						'blockName'    => 'core/video',
						'attrs'        => array(
							'src'      => 'https://example.com/video.mp4',
							'controls' => true,
							'caption'  => 'Demo video',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '',
						'innerContent' => array(),
					),
				),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$content = $result['preview']['post_content'];
		$this->assertStringContainsString( '<!-- wp:more {"customText":"Continue","noTeaser":true} --><!--more Continue-->', $content );
		$this->assertStringContainsString( '<!--noteaser--><!-- /wp:more -->', $content );
		$this->assertStringContainsString( '<!-- wp:html {"content":"Raw HTML"} --><div>Raw HTML</div><!-- /wp:html -->', $content );
		$this->assertStringContainsString( '<!-- wp:shortcode {"text":"[gallery ids=\"1,2\"]"} -->[gallery ids="1,2"]<!-- /wp:shortcode -->', $content );
		$this->assertStringContainsString( '<div class="wp-block-file"><a id="file-link" href="https://example.com/file.pdf">Brochure.pdf</a><a href="https://example.com/file.pdf" class="wp-block-file__button wp-element-button" download aria-describedby="file-link">Download file</a></div>', $content );
		$this->assertStringContainsString( '<figure class="wp-block-video"><video controls src="https://example.com/video.mp4"></video><figcaption class="wp-element-caption">Demo video</figcaption></figure>', $content );
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

	public function test_parsed_blocks_schema_treats_attrs_as_json_values_not_schema_types(): void {
		$schema = $this->parsed_blocks_schema();

		$this->assertSame( 'array', $schema['type'] );
		$this->assertSame( 'object', $schema['items']['type'] );
		$this->assertSame(
			array( 'string', 'number', 'integer', 'boolean', 'array', 'object', 'null' ),
			$schema['items']['properties']['attrs']['additionalProperties']['type']
		);
		$this->assertSame(
			array( 'string', 'null' ),
			$schema['items']['properties']['innerContent']['items']['type']
		);
	}

	public function test_update_post_with_blocks_merges_unique_top_level_block_into_existing_content(): void {
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post(
			12,
			'Existing title',
			'<!-- wp:heading --><h2>All executable blocks</h2><!-- /wp:heading -->'
			. '<!-- wp:paragraph --><p>Intro copy</p><!-- /wp:paragraph -->'
			. '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:paragraph --><p>Old grouped paragraph</p><!-- /wp:paragraph --></div><!-- /wp:column --></div><!-- /wp:columns -->'
			. '<!-- wp:details {"summary":"Expandable details"} --><details class="wp-block-details"><summary>Expandable details</summary><!-- wp:paragraph --><p>Hidden details content.</p><!-- /wp:paragraph --></details><!-- /wp:details -->',
			''
		);

		$result = $this->update_post(
			array(
				'post_id' => 12,
				'blocks'  => $this->four_column_heading_blocks(),
				'dry_run' => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString( '<!-- wp:heading --><h2>All executable blocks</h2><!-- /wp:heading -->', $result['after']['post_content'] );
		$this->assertStringContainsString( '<!-- wp:paragraph --><p>Intro copy</p><!-- /wp:paragraph -->', $result['after']['post_content'] );
		$this->assertStringContainsString( '<!-- wp:details {"summary":"Expandable details"} -->', $result['after']['post_content'] );
		$this->assertStringContainsString( '<h2>4</h2>', $result['after']['post_content'] );
		$this->assertStringNotContainsString( 'Old grouped paragraph', $result['after']['post_content'] );
	}

	public function test_update_post_with_replace_content_true_overwrites_existing_content(): void {
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post(
			12,
			'Existing title',
			'<!-- wp:heading --><h2>Keep me only when merging</h2><!-- /wp:heading -->',
			''
		);

		$result = $this->update_post(
			array(
				'post_id'         => 12,
				'blocks'          => $this->four_column_heading_blocks(),
				'replace_content' => true,
				'dry_run'         => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringNotContainsString( 'Keep me only when merging', $result['after']['post_content'] );
		$this->assertStringContainsString( '<h2>1</h2>', $result['after']['post_content'] );
	}

	public function test_update_post_can_insert_blocks_after_nth_paragraph_in_dry_run(): void {
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post(
			12,
			'Existing title',
			'<!-- wp:paragraph --><p>Paragraph 1</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Paragraph 2</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Paragraph 3</p><!-- /wp:paragraph -->',
			'Old excerpt'
		);

		$result = $this->update_post(
			array(
				'post_id'                => 12,
				'insert_after_paragraph' => 2,
				'blocks'                 => array(
					array(
						'blockName'    => 'core/image',
						'attrs'        => array(
							'id'  => 0,
							'url' => 'https://example.test/wp-content/uploads/test.jpeg',
							'alt' => 'test',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
						'innerContent' => array( '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>' ),
					),
				),
				'dry_run'                => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString( '<p>Paragraph 1</p>', $result['after']['post_content'] );
		$this->assertStringContainsString( '<p>Paragraph 2</p><!-- wp:image {"id":0,"url":"https://example.test/wp-content/uploads/test.jpeg","alt":"test"} -->', $result['after']['post_content'] );
		$this->assertStringContainsString( '<p>Paragraph 3</p>', $result['after']['post_content'] );
	}

	public function test_update_post_can_insert_blocks_at_end_in_dry_run(): void {
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post(
			12,
			'Existing title',
			'<!-- wp:paragraph --><p>Paragraph 1</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Paragraph 2</p><!-- /wp:paragraph -->',
			'Old excerpt'
		);

		$result = $this->update_post(
			array(
				'post_id'         => 12,
				'insert_position' => 'end',
				'blocks'          => array(
					array(
						'blockName'    => 'core/image',
						'attrs'        => array(
							'id'  => 0,
							'url' => 'https://example.test/wp-content/uploads/test.jpeg',
							'alt' => 'test',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
						'innerContent' => array( '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>' ),
					),
				),
				'dry_run'         => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringEndsWith(
			'<!-- wp:image {"id":0,"url":"https://example.test/wp-content/uploads/test.jpeg","alt":"test"} --><figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure><!-- /wp:image -->',
			$result['after']['post_content']
		);
	}

	public function test_update_post_can_insert_blocks_after_matching_block_in_dry_run(): void {
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post(
			12,
			'Existing title',
			'<!-- wp:paragraph --><p>Paragraph 1</p><!-- /wp:paragraph --><!-- wp:heading {"level":2} --><h2 class="wp-block-heading">Heading A</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Paragraph 2</p><!-- /wp:paragraph --><!-- wp:heading {"level":2} --><h2 class="wp-block-heading">Heading B</h2><!-- /wp:heading -->',
			'Old excerpt'
		);

		$result = $this->update_post(
			array(
				'post_id'            => 12,
				'insert_after_block' => array(
					'block_name' => 'core/heading',
					'from_end'   => true,
				),
				'blocks'             => array(
					array(
						'blockName'    => 'core/image',
						'attrs'        => array(
							'id'  => 0,
							'url' => 'https://example.test/wp-content/uploads/test.jpeg',
							'alt' => 'test',
						),
						'innerBlocks'  => array(),
						'innerHTML'    => '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>',
						'innerContent' => array( '<figure class="wp-block-image"><img src="https://example.test/wp-content/uploads/test.jpeg" alt="test"/></figure>' ),
					),
				),
				'dry_run'            => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString(
			'<h2 class="wp-block-heading">Heading B</h2><!-- /wp:heading --><!-- wp:image {"id":0,"url":"https://example.test/wp-content/uploads/test.jpeg","alt":"test"} -->',
			$result['after']['post_content']
		);
	}

	public function test_update_post_can_insert_blocks_before_matching_block_in_dry_run(): void {
		$GLOBALS['sitepilot_test_posts'][12] = new WP_Post(
			12,
			'Existing title',
			'<!-- wp:paragraph --><p>Paragraph 1</p><!-- /wp:paragraph --><!-- wp:heading {"level":2} --><h2 class="wp-block-heading">Heading A</h2><!-- /wp:heading -->',
			'Old excerpt'
		);

		$result = $this->update_post(
			array(
				'post_id'             => 12,
				'insert_before_block' => array(
					'block_name' => 'core/heading',
				),
				'blocks'              => array(
					array(
						'blockName'    => 'core/paragraph',
						'attrs'        => array(),
						'innerBlocks'  => array(),
						'innerHTML'    => '<p>Inserted before heading</p>',
						'innerContent' => array( '<p>Inserted before heading</p>' ),
					),
				),
				'dry_run'             => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertStringContainsString(
			'<p>Paragraph 1</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Inserted before heading</p><!-- /wp:paragraph --><!-- wp:heading {"level":2} -->',
			$result['after']['post_content']
		);
	}

	public function test_set_post_seo_meta_uses_sitepilot_keys_by_default(): void {
		$result = $this->seo_meta(
			array(
				'post_id'         => 12,
				'seo_title'       => 'SitePilot Title',
				'seo_description' => 'SitePilot Description',
				'dry_run'         => false,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'sitepilot', $result['meta_provider'] );
		$this->assertSame( 'SitePilot Title', $GLOBALS['sitepilot_test_post_meta'][12]['_sitepilot_seo_title'] );
		$this->assertSame( 'SitePilot Description', $GLOBALS['sitepilot_test_post_meta'][12]['_sitepilot_seo_description'] );
	}

	public function test_set_post_seo_meta_uses_yoast_keys_when_requested(): void {
		$result = $this->seo_meta(
			array(
				'post_id'         => 12,
				'seo_title'       => 'Yoast Title',
				'seo_description' => 'Yoast Description',
				'meta_provider'   => 'yoast',
				'dry_run'         => false,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'yoast', $result['meta_provider'] );
		$this->assertSame( 'Yoast Title', $GLOBALS['sitepilot_test_post_meta'][12]['_yoast_wpseo_title'] );
		$this->assertSame( 'Yoast Description', $GLOBALS['sitepilot_test_post_meta'][12]['_yoast_wpseo_metadesc'] );
	}

	public function test_set_post_featured_image_updates_thumbnail_meta(): void {
		$GLOBALS['sitepilot_test_posts'][201] = new WP_Post( 201, 'Image', '', '' );

		$result = $this->featured_image(
			array(
				'post_id'       => 12,
				'attachment_id' => 201,
				'dry_run'       => false,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 201, $result['attachment_id'] );
		$this->assertSame( '201', $GLOBALS['sitepilot_test_post_meta'][12]['_thumbnail_id'] );
	}

	public function test_set_post_featured_image_requires_attachment_id(): void {
		$result = $this->featured_image(
			array(
				'post_id' => 12,
				'dry_run' => false,
			)
		);

		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'missing_attachment_id', $result['error'] );
	}

	public function test_upload_media_asset_dry_run_returns_preview(): void {
		$result = $this->upload_media(
			array(
				'file_name'   => 'hero.png',
				'media_type'  => 'image/png',
				'data_base64' => base64_encode( 'fake-image-bytes' ),
				'alt_text'    => 'Hero image',
				'dry_run'     => true,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertTrue( $result['dry_run'] );
		$this->assertSame( 'hero.png', $result['file_name'] );
		$this->assertSame( 'image/png', $result['media_type'] );
		$this->assertSame( strlen( 'fake-image-bytes' ), $result['bytes'] );
		$this->assertSame( 'Hero image', $result['preview']['alt_text'] );
	}

	public function test_upload_media_asset_persists_attachment_and_returns_url(): void {
		$result = $this->upload_media(
			array(
				'file_name'   => 'gallery-shot.jpg',
				'media_type'  => 'image/jpeg',
				'data_base64' => base64_encode( 'binary-jpeg-data' ),
				'alt_text'    => 'Gallery shot',
				'dry_run'     => false,
			)
		);

		$this->assertTrue( $result['ok'] );
		$this->assertFalse( $result['dry_run'] );
		$this->assertSame( 'gallery-shot.jpg', $result['file_name'] );
		$this->assertSame( 'image/jpeg', $result['media_type'] );
		$this->assertSame( 'https://example.test/wp-content/uploads/gallery-shot.jpg', $result['url'] );
		$this->assertGreaterThan( 0, $result['attachment_id'] );
		$this->assertSame( 'Gallery shot', $GLOBALS['sitepilot_test_attachment_meta'][ $result['attachment_id'] ]['_wp_attachment_image_alt'] );
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
