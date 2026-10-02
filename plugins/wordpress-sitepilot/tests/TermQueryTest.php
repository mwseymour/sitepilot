<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Mcp\Post_Query;
use SitePilot\Mcp\Term_Query;

final class TermQueryTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_terms'] = array(
			'category' => array(
				new WP_Term( 3, 'news', 'News', 0, 12 ),
				new WP_Term( 4, 'travel', 'Travel', 0, 5 ),
				new WP_Term( 7, 'lake-district', 'Lake District', 4, 2 ),
			),
			'post_tag' => array(
				new WP_Term( 9, 'walking', 'Walking &amp; hiking', 0, 1 ),
			),
		);
		$GLOBALS['sitepilot_test_post_tags'] = array();
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_terms'], $GLOBALS['sitepilot_test_post_tags'] );
		parent::tearDown();
	}

	public function test_lists_categories_by_default_with_their_parents_and_counts(): void {
		$result = Term_Query::list_terms( array() );

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'category', $result['taxonomy'] );
		$this->assertTrue( $result['hierarchical'] );
		$this->assertSame( 3, $result['total_matches'] );
		$this->assertFalse( $result['truncated'] );
		$this->assertSame(
			array( 'term_id' => 7, 'slug' => 'lake-district', 'name' => 'Lake District', 'parent' => 4, 'count' => 2 ),
			$result['terms'][2]
		);
	}

	public function test_searches_limits_and_filters_by_parent(): void {
		$limited = Term_Query::list_terms( array( 'limit' => 1 ) );
		$this->assertCount( 1, $limited['terms'] );
		$this->assertSame( 3, $limited['total_matches'] );
		$this->assertTrue( $limited['truncated'] );

		$children = Term_Query::list_terms( array( 'parent' => 4 ) );
		$this->assertSame( array( 'lake-district' ), array_column( $children['terms'], 'slug' ) );

		$tags = Term_Query::list_terms( array( 'taxonomy' => 'post_tag', 'search' => 'walk' ) );
		$this->assertFalse( $tags['hierarchical'] );
		$this->assertSame( 'Walking & hiking', $tags['terms'][0]['name'] );
	}

	public function test_refuses_private_and_unknown_taxonomies(): void {
		$this->assertSame( 'invalid_taxonomy', Term_Query::list_terms( array( 'taxonomy' => 'wp_pattern_category' ) )['error'] );
		$this->assertSame( 'invalid_taxonomy', Term_Query::list_terms( array( 'taxonomy' => 'nope' ) )['error'] );
	}

	public function test_a_post_lists_its_tags(): void {
		$GLOBALS['sitepilot_test_post_tags'][12] = array( new WP_Term( 9, 'walking', 'Walking', 0, 1 ) );

		$this->assertSame( array( 'walking' ), Post_Query::get_post( array( 'post_id' => 12 ) )['tag_slugs'] );
	}
}
