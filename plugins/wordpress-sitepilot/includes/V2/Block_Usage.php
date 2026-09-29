<?php
/**
 * Read-only scan of how the site's content uses third-party blocks.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * Counts non-core blocks in the posts and pages the SitePilot user can edit,
 * with a few stored examples of each. Nothing is written.
 */
final class Block_Usage {

	/** Most recently modified posts and pages to scan. */
	public const MAX_POSTS = 2000;

	private const BATCH = 200;
	private const MAX_EXAMPLES = 3;
	private const MAX_EXAMPLE_BYTES = 4000;

	/** @return array<string, mixed> */
	public static function scan(): array {
		global $wpdb;
		$counts    = array();
		$scanned   = 0;
		$offset    = 0;
		$truncated = false;
		while ( true ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$rows = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT ID, post_content FROM {$wpdb->posts} WHERE post_type IN ('post', 'page') AND post_status NOT IN ('trash', 'auto-draft', 'inherit') AND post_content LIKE %s ORDER BY post_modified_gmt DESC, ID DESC LIMIT %d OFFSET %d",
					'%' . $wpdb->esc_like( '<!-- wp:' ) . '%',
					self::BATCH,
					$offset
				)
			);
			if ( ! is_array( $rows ) || array() === $rows ) {
				break;
			}
			$offset += count( $rows );
			foreach ( $rows as $row ) {
				$post_id = (int) $row->ID;
				if ( ! current_user_can( 'edit_post', $post_id ) ) {
					continue;
				}
				if ( $scanned >= self::MAX_POSTS ) {
					$truncated = true;
					break 2;
				}
				++$scanned;
				$content = (string) $row->post_content;
				// Core blocks are stored without a namespace ("wp:paragraph").
				if ( ! preg_match( '#<!--\s+wp:[a-z][a-z0-9_-]*/#', $content ) ) {
					continue;
				}
				$seen = array();
				self::count_blocks( parse_blocks( $content ), $post_id, $counts, $seen );
			}
			if ( count( $rows ) < self::BATCH ) {
				break;
			}
		}
		$blocks = array();
		foreach ( $counts as $name => $entry ) {
			$blocks[] = array(
				'name'     => $name,
				'posts'    => count( $entry['posts'] ),
				'uses'     => $entry['uses'],
				'examples' => $entry['examples'],
			);
		}
		usort(
			$blocks,
			static fn( array $left, array $right ): int => ( $right['posts'] <=> $left['posts'] ) ?: strcmp( $left['name'], $right['name'] )
		);
		return array(
			'schemaVersion' => 'sitepilot.block-usage/v2',
			'scannedPosts'  => $scanned,
			'truncated'     => $truncated,
			'blocks'        => $blocks,
		);
	}

	/**
	 * @param array<int, array<string, mixed>> $blocks Parsed blocks.
	 * @param array<string, array<string, mixed>> $counts Running counts by block name.
	 * @param array<string, bool> $seen Block names already counted for this post.
	 */
	private static function count_blocks( array $blocks, int $post_id, array &$counts, array &$seen ): void {
		foreach ( $blocks as $block ) {
			$name = isset( $block['blockName'] ) && is_string( $block['blockName'] ) ? $block['blockName'] : '';
			if ( '' !== $name && str_contains( $name, '/' ) && ! str_starts_with( $name, 'core/' ) ) {
				if ( ! isset( $counts[ $name ] ) ) {
					$counts[ $name ] = array( 'posts' => array(), 'uses' => 0, 'examples' => array() );
				}
				++$counts[ $name ]['uses'];
				$counts[ $name ]['posts'][ $post_id ] = true;
				if ( ! isset( $seen[ $name ] ) && count( $counts[ $name ]['examples'] ) < self::MAX_EXAMPLES ) {
					$attributes = wp_json_encode( (object) ( is_array( $block['attrs'] ?? null ) ? $block['attrs'] : array() ) );
					if ( is_string( $attributes ) && strlen( $attributes ) <= self::MAX_EXAMPLE_BYTES ) {
						$counts[ $name ]['examples'][] = array( 'postId' => $post_id, 'attributes' => $attributes );
					}
				}
				$seen[ $name ] = true;
			}
			if ( isset( $block['innerBlocks'] ) && is_array( $block['innerBlocks'] ) ) {
				self::count_blocks( $block['innerBlocks'], $post_id, $counts, $seen );
			}
		}
	}
}
