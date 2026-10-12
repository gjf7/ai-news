import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BlogSearchParams } from "@ai-news/contracts";
import { blogPostsQueryOptions, blogsQueryOptions } from "../../api/blogs.ts";
import { Button, EmptyState, ErrorNotice, Spinner } from "../../components/ui/primitives.tsx";
import { relativeTime } from "../../lib/format.ts";

export const Route = createFileRoute("/_authenticated/blogs")({
  validateSearch: BlogSearchParams,
  component: BlogsPage,
});

function BlogsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const page = search.page ?? 1;

  const blogs = useQuery(blogsQueryOptions);
  const posts = useQuery(blogPostsQueryOptions({ blog: search.blog, page }));

  const selectBlog = (blog: string | undefined) => {
    void navigate({ to: "/blogs", search: { blog, page: 1 } });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">博客</h1>
        <p className="mt-1 text-xs text-neutral-500">
          个人博客的最新文章。只显示标题，点击到原站阅读。
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <BlogChip label="全部" active={!search.blog} onClick={() => selectBlog(undefined)} />
        {(blogs.data ?? []).map((blog) => (
          <BlogChip
            key={blog.key}
            label={blog.postCount > 0 ? `${blog.name} ${blog.postCount}` : blog.name}
            active={search.blog === blog.key}
            onClick={() => selectBlog(blog.key)}
          />
        ))}
      </div>

      {blogs.isPending || posts.isPending ? <Spinner label="加载中…" /> : null}
      {blogs.error || posts.error ? <ErrorNotice message="加载失败，请刷新页面重试" /> : null}

      {posts.data && posts.data.items.length === 0 ? (
        <EmptyState title="还没有文章" hint="博客会在下一次刷新时抓取，稍后再看看。" />
      ) : null}

      {posts.data && posts.data.items.length > 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white px-5 py-2">
          {posts.data.items.map((post) => (
            <article
              key={post.id}
              className="border-b border-neutral-200 py-3 first:pt-1 last:border-b-0"
            >
              <a
                href={post.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-medium text-neutral-900 hover:underline"
              >
                {post.title}
              </a>
              <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
                <span>{post.blogName}</span>
                {post.publishedAt ? <span>· {relativeTime(post.publishedAt)}</span> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {posts.data && (page > 1 || posts.data.hasMore) ? (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() =>
              void navigate({ to: "/blogs", search: { blog: search.blog, page: page - 1 } })
            }
            disabled={page <= 1}
          >
            上一页
          </Button>
          <span className="text-xs text-neutral-400">第 {page} 页</span>
          <Button
            variant="ghost"
            onClick={() =>
              void navigate({ to: "/blogs", search: { blog: search.blog, page: page + 1 } })
            }
            disabled={!posts.data.hasMore}
          >
            下一页
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BlogChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white"
          : "border-neutral-200 text-neutral-600 hover:bg-neutral-100"
      }`}
    >
      {label}
    </button>
  );
}
